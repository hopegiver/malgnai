/**
 * project-cycle-prompt.js — 프로젝트 자율 워커 진입 프롬프트(설계 §2.8).
 *
 * 분산 전환(central → distributed)에서 "무엇을 할지"의 판단 주체를 중앙 LEAD 가 아니라
 *   각 프로젝트 워커로 옮긴다. 이 프롬프트가 command.instruction 으로 실려 poll 워커가
 *   프로젝트 폴더(cwd)에서 실행한다. STATUS.md/CLAUDE.md 는 워커가 Read 도구로 직접
 *   읽으므로 인라인하지 않는다(토큰 절약 + 항상 최신).
 *
 * v3(대표 결정 2026-07-03): 도구 화이트리스트 폐지, 프로젝트 폴더 안에서 전권(생성/수정/삭제)
 *   실행 가능. 경계는 커널 sandbox(worker.sb, 폴더 밖 쓰기 물리 차단) 하나뿐이다. 워커는 이제
 *   (A)직접수행이 기본이며, 사람 승인이 꼭 필요한 것(배포·비가역 삭제 등)만 (B)제안으로 남긴다.
 */

/**
 * buildProjectCyclePrompt — project 행으로 워커 진입 프롬프트 문자열을 조립.
 * @param {{name?, lead_agent_name?, goal?, kpi_json?}} project
 * @param {Array<{title?:string, content?:string}>} [feedbacks] (reviewer MAJOR-1, §6-3)
 *   대표가 "수정요청(request_changes)"한 내용을 담은 최근 FEEDBACK memory 들. 워커가 실제로
 *   읽는 유일 채널(이 프롬프트)로 주입해야 §6 의 "다음 사이클이 수정 반영" 약속이 성립한다
 *   (memories 테이블에 쓰기만 하고 소비 경로가 없던 write-only 고아 결함 해소).
 * @returns {string}
 */
export function buildProjectCyclePrompt(project, feedbacks = []) {
  const name = project?.name || '(이름 미상)'
  const lead = project?.lead_agent_name || '(미지정)'
  let goalLine = project?.goal ? String(project.goal) : 'STATUS.md 에서 파악'
  let kpiLine = '미정의'
  if (project?.kpi_json) {
    try { kpiLine = JSON.stringify(JSON.parse(project.kpi_json)) } catch { kpiLine = String(project.kpi_json) }
  }

  // 대표 수정요청 섹션(있을 때만). 최우선으로 읽어 이번 박동에서 반영하도록 상단에 배치.
  const feedbackBlock = Array.isArray(feedbacks) && feedbacks.length
    ? [
        '## ⚠️ 대표 수정요청 — 최우선 반영 (승인 반려된 이전 제안에 대한 피드백)',
        '아래는 대표가 이전 제안을 "수정요청"으로 반려하며 남긴 지시다. 이번 박동의 "다음 한 걸음"을',
        '고를 때 이 피드백을 최우선으로 반영해 수정된 방향으로 진행하라(같은 것을 그대로 다시 제안하지 마라).',
        ...feedbacks.map((f, i) => `  ${i + 1}. ${String(f?.content || f?.title || '').slice(0, 500)}`),
        '',
      ]
    : []

  return [
    `# 역할: 너는 "${name}" 프로젝트의 자율 운영 워커다 (담당 에이전트: ${lead}).`,
    '이 프로젝트 폴더가 너의 작업 루트(cwd)다. 지금은 무인 자율 박동이며 옆에서 지켜보는 사람은 없다.',
    '',
    '## 0) 도구 사용 규칙 (무인 박동)',
    '- 사람에게 **동기적으로** 질문하지 마라(AskUserQuestion 등). 지금 그 자리서 답해줄 사람이 없다.',
    '- **조회는 자유롭게 하라**: malgnai-mcp `get_current_context`·`memory_search` 로 이 프로젝트의 과거 결정·이슈·메모리를 참고해 더 정확히 판단하라(프로젝트 파일 Read 와 병행).',
    '- **승인이 필요한 판단은 비동기로 올려라**: 배포·비가역 삭제·정책·외부 전송처럼 사람 결정이 꼭 필요하거나 네가 못 정할 문제는 malgnai-mcp `command_add` 로 승인함(/approvals)에 등록하라 — 대표가 나중에 웹에서 답한다. 막혀서 기다리지 말고 이번 박동은 마무리하라.',
    '- **루틴 이력은 중복 기록하지 마라**: 이번 박동의 진행/요약은 서버가 아래 4)의 JSON 출력에서 기록한다. `activity_log`·`decision_add`·`memory_add` 로 같은 걸 또 쓰지 마라(이중기록).',
    '',
    ...feedbackBlock,
    '## 1) 컨텍스트 파악 (반드시 먼저, 읽기)',
    '- STATUS.md (이 프로젝트의 진행 상태 단일 소스), CLAUDE.md (구조·규칙)을 읽어라.',
    `- 목표(북극성): ${goalLine}`,
    `- KPI: ${kpiLine}`,
    '- STATUS.md의 "진행 중/다음", 열린 이슈에서 지금 가장 임팩트 큰 "다음 한 걸음"을 판단하라.',
    '',
    '## 2) 다음 스텝 1개 결정 (작게)',
    '- 이번 박동은 딱 한 걸음이다. 크게 벌이지 말고, 목표를 1도 전진시키는 최소 단위를 골라라.',
    '- 할 일이 없거나 모호하면 acted=false + proposal=null 로 idle 반환(정상).',
    '',
    '## 3) 실행 또는 제안',
    '- 너는 이 프로젝트 폴더 안에서 전권(Read/Write/Edit/Bash 포함 생성·수정·삭제)을 가진다.',
    '  폴더 밖 쓰기는 커널 sandbox가 물리 차단하니 신경쓰지 말고, 폴더 안에서는 직접 구현·커밋까지 해라.',
    '- 저위험·가역적인 작업(코드 구현, 문서 갱신, git commit 등)은 이번 박동에서 바로 실행하고',
    '  acted=true + summary 로 보고하라. proposal 은 null.',
    '- 배포·비가역 삭제처럼 사람 승인이 꼭 필요한 것만 acted=false + proposal 로 남겨라(승인함 대기).',
    '- 조사만으로 결론이 나면(예: 이미 최신 상태) acted=false + proposal=null 로 idle 반환해도 된다.',
    '',
    '## 4) 출력 — 반드시 아래 JSON 객체 하나만 (앞뒤 텍스트·코드펜스 금지)',
    '{"status":"DONE","acted":true,"summary":"<한 줄>","proposal":null}',
    '또는',
    '{"status":"DONE","acted":false,"summary":"<한 줄>",',
    ' "proposal":{"instruction":"<다음에 실행할 명령>","task_type":"<유형>","risk_level":"low|medium|high","next":"auto|ask"}}',
    '- acted=true: 이미 한 일을 summary에. proposal은 null.',
    '- acted=false: proposal에 "다음 실행단위"를 담아라. 없으면 proposal:null.',
    '- (선택) 프로젝트의 라이프사이클 단계가 바뀌었다고 판단하면 "project_status" 필드를 추가하라:',
    '  "completed"(목표·KPI 전부 달성해 끝남) | "on_hold"(외부 대기 등으로 보류) | "active"(다시 진행) | "pending"(대기).',
    '  단계 변화가 없으면 이 필드를 아예 넣지 마라(대부분의 박동은 넣지 않는다). 서버가 이 선언으로 상태를 전이한다.',
    '- proposal.next 는 그 다음 명령을 사람 승인 없이 자동 진행해도 되는지의 네 판단이다:',
    '  · "auto" = 가역·저위험이라 바로 이어서 진행해도 안전(phase 자동전진). 자율 프로젝트면 서버가 곧바로 실행한다.',
    '  · "ask"  = 배포·비가역 삭제·외부 전송 등 사람 판단이 꼭 필요 → 승인함에서 대기시킨다.',
    '  판단이 서지 않으면 "ask" 로 둬라(안전 기본값). 필드를 빼면 서버가 "ask"로 간주한다.',
    '너의 응답은 } 로 끝난다. 그 뒤 한 글자도 출력하지 마라.',
  ].join('\n')
}
