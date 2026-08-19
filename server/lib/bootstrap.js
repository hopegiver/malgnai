// project_bootstrap 공통 구현(mcp-tools.md §4.11, 구 bootstrap_project) — projects get-or-create
// 후 project_get_context와 동일한 조합 로직(server/lib/context.js)으로 state/decisions/issues/
// recentWork를 모아 STATUS.md 마크다운 문자열 하나로 조립해 반환한다. 포맷을 서버가 소유 —
// 클라이언트는 그대로 파일에 쓰기만 하면 된다. 이미 존재하는 프로젝트 재호출은 아무것도 덮어쓰지
// 않고 조회만(멱등). claudeMarkdown/docsReadmeMarkdown/scaffoldFolders는 D1 조회에 의존하지 않는
// 고정 템플릿이라 isNew나 컨텍스트 조회 성공 여부와 무관하게 항상 같은 값을 반환한다(§4.11 "비정상
// 케이스"). state는 project_states 폐기(2026-07-28) 이후 즉석 계산 — camelCase 키(phase/health/
// progress/currentWork/nextAction/blockerSummary)로 반환된다(§4.1).
//
// 2026-08-11 repositories 테이블 폐기(architecture.md §0 결정22) — repositoryKey는 이제 projects가
// 직접 보유하는 단순 정보값이고 (user_id, repositoryKey)로만 유니크하다(전역 유니크 아님). 이 도구가
// 여전히 malgnai-hub 진입점이지만, 나머지 12개 도구는 이 응답의 projectId를 그대로 받는다 —
// repositoryKey는 최초 등록 이후 다시 보낼 필요가 없다.
import * as projectsDao from '../dao/projects.js'
import { getProjectContext } from './context.js'
import { normalizeRepositoryKey } from './repository-key.js'

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

// CLAUDE.md 템플릿(mcp-tools.md §4.11) — isNew/D1 조회 결과와 무관하게 항상 같은 고정 내용(치환값
// 없음). 2026-08-11 projectId 전면 전환 반영 — project_bootstrap만 repositoryKey를 쓰고, 나머지
// 12개 도구는 STATUS.md에 적힌 projectId를 그대로 받는다(mcp-tools.md §4.0).
function renderClaudeMarkdown() {
  return `# CLAUDE.md

이 프로젝트는 malgnai-hub(맑은소프트 공통 프로젝트 메모리 MCP)로 작업 이력을 추적한다.

## 새 세션 부트스트랩
- **L0(항상):** 이 파일 + \`STATUS.md\`. \`STATUS.md\`가 없거나 상단 YAML frontmatter에 \`malgnai_hub.project_id\`가 없으면 **아직 malgnai-hub에 등록되지 않은 프로젝트**다 — 아래 "최초 등록" 절차를 먼저 따른다.
- **L1(필요 시):** 텍스트 검색이 필요하면 \`project_search_history\` MCP 도구 호출.
- **상황 파악하려고 코드/문서 통독 금지** — STATUS.md + 이 파일이면 대부분 충분.

## 최초 등록(STATUS.md에 malgnai_hub.project_id가 없을 때만)
1. 이 프로젝트가 속한 워크스페이스 폴더명을 \`repositoryKey\`로 삼아 \`project_bootstrap\`을 호출한다(예: \`~/workspace/foo/\`이면 \`repositoryKey="foo"\`). \`repositoryKey\`는 이 프로젝트를 가리키는 단순 정보값일 뿐 전역에서 유일할 필요가 없다 — 나중에 GitHub 리포지토리와 연동되면 그 owner/repo 값으로 바꿔도 된다.
2. 응답의 \`isNew\`가 \`true\`면 그대로 진행: \`statusMarkdown\`/\`claudeMarkdown\`/\`docsReadmeMarkdown\`을 각각 STATUS.md/CLAUDE.md/docs/README.md에 쓰고 \`scaffoldFolders\`의 폴더를 만든다(이미 내용이 채워진 파일이 있으면 덮어쓰지 않는다).
3. 응답의 \`isNew\`가 \`false\`면 같은 이름의 프로젝트가 이미 등록돼 있었다는 뜻이다(다른 실제 프로젝트와 폴더명이 우연히 겹쳤을 수 있음) — **대화형 세션이면 사용자에게 이 프로젝트를 재사용할지 확인한 뒤** 채택하고, 확인이 어려운 상황(예: 비대화형 자동화)이면 그대로 채택해 진행한다.
4. 이렇게 확정된 \`projectId\`를 STATUS.md 상단 frontmatter(\`malgnai_hub.project_id\`)에 기록해두면, 이후 세션은 이 값을 읽어 바로 4번 규칙으로 넘어간다.

## malgnai-hub MCP 사용 규칙
- **모든 도구(project_bootstrap 제외)는 \`projectId\` 필수** — STATUS.md의 \`malgnai_hub.project_id\`를 그대로 넘긴다. \`repositoryKey\`는 최초 등록(project_bootstrap) 1회만 쓰고 이후에는 다시 보낼 필요가 없다.
- **작업 시작 전**: \`project_get_context\`로 현재 상태·최근 결정·열린 이슈를 먼저 확인한다.
- **의미 있는 작업을 마쳤을 때**: \`work_record\`(started/progress/completed/blocked 상태와 요약, \`nextAction\`을 채워두면 다음 세션의 현재상태에 그대로 이어짐).
- **중요한 결정을 내렸을 때**: \`decision_record\`(결정+이유, \`importance\`는 매번 실제로 판단해서 1~5 지정 — 기본값 3 습관적 사용 금지).
- **막힌 것/장애물을 발견했을 때**: \`issue_record\`, 해결되면 \`issue_resolve\`(issueId 필요 — issue_record 응답의 issueId를 보관해둘 것).
- **여러 단계로 나뉘는 작업**: \`wbs_add\`/\`wbs_bulk_add\`로 계획을 등록하고, 단계가 끝날 때마다 \`wbs_update\`로 갱신.

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
 * → { projectId, isNew, webUrl, statusMarkdown, claudeMarkdown, docsReadmeMarkdown, scaffoldFolders }
 *
 * 2026-08-11 repositories 테이블 폐기 이후 get-or-create는 projects 테이블 하나에서
 * (user_id, repository_key)로만 이뤄진다 — repositoryKey는 전역 유니크가 아니다.
 */
export async function bootstrapProject(db, userId, { repositoryKey, repositoryName, projectName } = {}) {
  if (!repositoryKey || typeof repositoryKey !== 'string') {
    throw validationError('repositoryKey is required')
  }

  repositoryKey = normalizeRepositoryKey(repositoryKey)
  if (!repositoryKey) {
    throw validationError('repositoryKey is required')
  }

  // isNew 판정을 위해 get-or-create 전에 먼저 존재 여부를 확인(projectsDao.getOrCreateForUser는
  // 존재/생성 여부를 알려주지 않고 row만 반환하므로 — 다른 11개 도구의 계약을 바꾸지 않기 위한 최소 변경).
  const existing = await db.prepare('SELECT * FROM projects WHERE user_id = ? AND repository_key = ?')
    .bind(userId, repositoryKey).first()
  const isNew = !existing
  const project = existing || await projectsDao.getOrCreateForUser(db, userId, repositoryKey, repositoryName, projectName)

  // §4.11: state(즉석계산)/decisions(상위5)/issues(open, 상위5)/recentWork(상위5) — wbs는 STATUS.md
  // 템플릿이 쓰지 않으므로 sections에서 제외해 불필요한 쿼리를 만들지 않는다.
  const ctx = await getProjectContext(db, project.id, { sections: ['state', 'decisions', 'issues', 'recentWork'], limit: 5 })

  const webUrl = `${WEB_ORIGIN}/projects/${project.id}`
  const statusMarkdown = `---
malgnai_hub:
  project_id: "${esc(project.id)}"
  repository_key: "${esc(project.repository_key)}"
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
- **이 project_id를 project_bootstrap 이후의 모든 malgnai-hub MCP 도구 호출에 그대로 쓴다** — repositoryKey는 이 등록 1회로 끝, 다시 보낼 필요 없다.
- 상세 이력은 \`${webUrl}\`에서 조회하거나 \`project_search_history\`/\`project_get_context\` MCP 도구로 조회.
`

  return {
    projectId: project.id,
    isNew,
    webUrl,
    statusMarkdown,
    claudeMarkdown: renderClaudeMarkdown(),
    docsReadmeMarkdown: DOCS_README_MARKDOWN,
    scaffoldFolders: SCAFFOLD_FOLDERS
  }
}
