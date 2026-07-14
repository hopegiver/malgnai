/**
 * feature-review-prompt.js — 기능 개선 요청 완전자동 심사 워커 진입 프롬프트.
 *
 * engine/feature-review.js가 이 프롬프트로 claude 워커를 1회 실행(-p, 저턴수)해 승인/반려를
 *   판정한다. project-cycle-prompt.js(자율 박동, 실행 지시)와 목적이 다르다 — 이건 순수 심사
 *   (읽기 위주, 실행 없음)라 별도 파일로 분리했다. JSON-only 강제 스타일은 project-cycle-prompt.js
 *   관례를 그대로 따른다.
 */

/**
 * buildFeatureReviewPrompt — project + featureRequest 로 심사 워커 진입 프롬프트 문자열을 조립.
 * @param {{name?, goal?, kpi_json?}} project
 * @param {{title?, description?}} featureRequest
 * @returns {string}
 */
export function buildFeatureReviewPrompt(project, featureRequest) {
  const name = project?.name || '(이름 미상)'
  const goalLine = project?.goal ? String(project.goal) : 'STATUS.md 에서 파악'
  let kpiLine = '미정의'
  if (project?.kpi_json) {
    try { kpiLine = JSON.stringify(JSON.parse(project.kpi_json)) } catch { kpiLine = String(project.kpi_json) }
  }
  const title = String(featureRequest?.title || '(제목 없음)')
  const description = featureRequest?.description ? String(featureRequest.description) : '(설명 없음)'

  return [
    `# 역할: 너는 "${name}" 프로젝트의 기능 개선 요청 완전자동 심사관이다.`,
    '사람의 승인 개입 없이 네 판단만으로 이 요청을 승인(approve) 또는 반려(reject)해야 한다. 신중하고 깐깐하게 심사하라.',
    '',
    '## 1) 프로젝트 컨텍스트 (참고용, 필요하면 읽어라)',
    `- 목표(북극성): ${goalLine}`,
    `- KPI: ${kpiLine}`,
    '- 필요하면 STATUS.md / CLAUDE.md 를 Read 로 확인하고, malgnai-mcp `memory_search`로 과거 결정·이슈·기존 기능요청과의 중복 여부를 조회하라.',
    '- **이 프롬프트는 심사 전용이다. 코드/파일을 수정하거나 실행하지 마라 — 오직 판단만 내려라.**',
    '',
    '## 2) 심사 대상 기능 개선 요청',
    `- 제목: ${title}`,
    `- 설명: ${description}`,
    '',
    '## 3) 평가 기준 — 아주 깐깐하게 심사하라. 승인은 예외적으로만 내려야 한다.',
    '- **[1차 게이트] 전체 사용자 유용성**: 이 요청이 malgnai를 쓰는 특정 개인 한 명(요청자 자신)의 취향·편의·개인 워크플로우를 위한 것인가, 아니면 malgnai를 쓰는 사용자 전체에게 실질적으로 유용한가. 개인화 설정, 특정 프로젝트 하나만을 위한 특례, 요청자 개인 취향으로 읽히면 그 근거를 사유에 명시하고 즉시 반려하라 — 이 게이트를 통과하지 못하면 아래 기준을 볼 필요도 없다.',
    '- **[2차 게이트] 필수성**: "있으면 좋다" 수준의 nice-to-have 아이디어인가, 아니면 malgnai의 안정성·핵심 운영·보안 등에 꼭 필요한 업그레이드인가. 승인은 후자, 즉 "이게 없으면 malgnai 운영에 실질적 지장/손해가 있다"고 확신할 수 있는 경우로만 한정하라. 단순히 편리해 보이거나 흥미로운 아이디어라는 이유만으로는 승인하지 마라.',
    '- **목표 정합성**: 이 요청이 프로젝트 목표/KPI 달성에 실제로 기여하는가, 아니면 무관하거나 방향이 어긋나는가.',
    '- **기술적 타당성**: 이 프로젝트의 현재 구조·스택으로 합리적인 비용에 구현 가능한가. 터무니없거나 비현실적인 요청은 반려하라.',
    '- **중복 여부**: 이미 구현됐거나, 이미 반영이 결정된(과거 결정/메모리) 것과 사실상 같은 요청이면 반려하라(사유에 그 사실을 명시).',
    '- **리스크/부작용**: 보안·데이터 무결성·기존 사용자 경험을 해칠 위험이 있는가. 위험이 크면 반려하거나, 위험을 줄일 수 있는 대안이 있다면 그 대안을 reason에 제안하라(단 이번 결정 자체는 승인/반려 둘 중 하나로만 내려라).',
    '- 5개 기준을 전부 통과해야만 승인이다. 하나라도 걸리거나 판단이 애매하면 **반려 쪽으로 보수적으로 판단**하라(완전자동 심사이므로 잘못된 승인의 비용이 잘못된 반려보다 훨씬 크다).',
    '',
    '## 4) 출력 — 반드시 아래 JSON 객체 하나만 (앞뒤 텍스트·코드펜스 금지)',
    '{"decision":"approve","reason":"<승인 사유 한두 문장>"}',
    '또는',
    '{"decision":"reject","reason":"<반려 사유 한두 문장 — 다음에 비슷한 요청이 왔을 때 참고할 수 있게 구체적으로>"}',
    '너의 응답은 } 로 끝난다. 그 뒤 한 글자도 출력하지 마라.',
  ].join('\n')
}
