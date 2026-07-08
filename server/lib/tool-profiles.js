/**
 * tool-profiles.js — 워커 권한 게이트 (Write Sandbox v3 — 대표 결정 2026-07-03).
 *
 * v2까지는 task_type별 도구 화이트리스트(read_only/write_diff)로 "무엇을 할 수 있는지"를 앱 레벨에서
 *   좁혔다. 그런데 화이트리스트는 애플리케이션이 스스로 지키는 약속이라 우회 가능함이 실증됐다
 *   (절대경로·심링크 쓰기로 diff-guard 우회 issue 4fd68bac, 전역 bypassPermissions가 --allowedTools
 *   자체를 무력화하는 issue b3a27771). 반면 커널 sandbox(worker.sb, sandbox-exec)는 OS가 물리적으로
 *   강제하는 경계라 우회 불가능함이 검증됐다(S7 등).
 *
 * v3 결정: 이중 방어가 사실상 "약한 자물쇠 + 진짜 담장"이었으므로, 약한 자물쇠(도구 화이트리스트)는
 *   폐지하고 **커널 sandbox 하나만 유일한 경계로 둔다.** 워커는 프로젝트 폴더 안에서 VSCode로 직접
 *   작업하던 것과 동일한 전권(생성/수정/삭제/임의 Bash)을 가지며, 폴더 밖 쓰기는 sandbox-exec가
 *   차단한다(파일쓰기 한정 — 네트워크는 Anthropic API 호출 때문에 열려있음, 크리덴셜 유출 리스크는
 *   issue 50e97da1로 별도 추적·수용 중).
 */
import { UNLIMITED_TURNS } from './worker-exec.js'

/**
 * resolveAllowedTools — 이제 항상 null(=도구 제한 없음, poll이 --permission-mode bypassPermissions로 실행).
 *   과거 task_type별 화이트리스트는 폐지(v3). 시그니처는 호환을 위해 유지.
 * @param {string|null} _taskType
 * @returns {null}
 */
export function resolveAllowedTools(_taskType) {
  return null
}

/**
 * resolveSandboxProfile — task_type 과 무관하게 항상 'sandbox'(유일한 경계, 심층방어 아닌 주 방어).
 * @param {string|null} _taskType
 * @returns {'sandbox'}
 */
export function resolveSandboxProfile(_taskType) {
  return 'sandbox'
}

// M-2: 안전 기본 max_turns(설계 §5.1 budget 기본값). agent budget 미설정 시 fallback.
const DEFAULT_MAX_TURNS = 8

/**
 * resolveMaxTurns — 이 명령의 워커 턴 상한을 정한다.
 *
 * **사람이 직접 낸 명령은 턴 무제한**(대표 지시 2026-07-07): task_type 이 자율 사이클(project_cycle)이
 *   아니면(=웹앱 direct 명령·승인함 승인분·resume 등 사람이 개입한 실행) UNLIMITED_TURNS 를 돌려
 *   워커가 --max-turns 없이 작업을 끝까지 수행한다. 대신 worker-exec.js 가 무제한일 때 단계화 지침
 *   (STAGED_EXECUTION_PROMPT)을 덧붙여 한 세션에서 토큰을 통째로 태우지 않게 유도한다.
 *
 * 자율 project_cycle 만 예산 상한을 유지한다: projectId → projects.lead_agent_name → agents.budget_json
 *   의 max_turns_per_task 를 읽고, 어느 단계든 비면 DEFAULT_MAX_TURNS(8) 로 안전 강제(무인 루프의
 *   토큰/비용 런어웨이 차단 — M-2). todayCostUsd/createBudgetGate(server/lib/autonomy.js)와 동일하게
 *   project_id → projects.lead_agent_name 스코프. §2.3(dispatch-worker.js)와 poll claim 라우트가
 *   이 함수 하나를 공유한다.
 *
 * @param {object} db  D1 호환 db(또는 트랜잭션 tx — 둘 다 prepare().bind().first() 표면 동일).
 * @param {object|string|null} command  command 객체(권장) 또는 하위호환용 projectId 문자열.
 * @returns {Promise<number>} UNLIMITED_TURNS(0, 사람 직접 명령) 또는 양의 정수 max_turns.
 */
export async function resolveMaxTurns(db, command) {
  // 하위호환: 예전 호출부가 projectId(문자열)만 넘기던 시그니처도 받아준다.
  const isObj = command != null && typeof command === 'object'
  const projectId = isObj ? command.project_id : command
  const taskType = isObj ? command.task_type : null

  // 사람이 개입한 명령(자율 project_cycle 이 아님)은 턴 무제한.
  if (taskType !== 'project_cycle') return UNLIMITED_TURNS

  try {
    let leadAgentName = null
    if (projectId) {
      const project = await db.prepare('SELECT lead_agent_name FROM projects WHERE id = ?')
        .bind(projectId).first()
      leadAgentName = project?.lead_agent_name || null
    }
    if (leadAgentName) {
      const agent = await db.prepare('SELECT budget_json FROM agents WHERE name = ?')
        .bind(leadAgentName).first()
      if (agent?.budget_json) {
        const b = JSON.parse(agent.budget_json)
        const n = Number(b?.max_turns_per_task)
        if (Number.isInteger(n) && n > 0) return n
      }
    }
  } catch { /* 어떤 실패든 안전 기본값으로 폴백 */ }
  return DEFAULT_MAX_TURNS
}
