/**
 * cycle-ingest.js — 프로젝트 자율 워커 결과의 **얇은 적재** 트랜잭션(설계 §2.9).
 *
 * distributed 단일 경로의 결과 적재다(구 central 중앙 배분 집행을 대체). **배분 없음** —
 *   워커가 스스로 판단해 (A)직접수행했거나 (B)제안만 냈다.
 *   서버는 관측성(summary→memories)과 제안의 승인함 등록(예산 게이트)만 한다.
 *
 * 가드레일: 예산 게이트(createBudgetGate), 마스터/프로젝트 자율 스위치(canAutoDispatch).
 *   "무엇을 할지"만 워커가 정하고, "실행해도 되는지"는 여전히 서버 게이트가 최종 결정한다
 *   (승인 우회 0 불변식 유지). P3(2026-07-03): 규칙엔진(evaluateSync/execution_rules) 제거.
 *
 * (설계 vscode-web-unified-execution.md §5, 2026-07-06): proposal = "다음 실행단위"다.
 *   워커가 proposal 에 실은 next 신호가 실행 가능/held 를 가른다 — next='auto' + 게이트 통과면
 *   'approved'(자동집행, 다음 phase 자동전진), 그 외(next='ask'·필드누락·게이트실패)는 'queued'
 *   (승인함). 이로써 지금껏 계산만 되고 안 쓰이던 canAutoDispatch 가 실제로 status 를 결정한다.
 *   ⚠️ 이 재정의 이전(구 v3)에는 이 분기에 도달한 proposal 을 무조건 queued 로 강제했다.
 *
 * better-sqlite3 동기 트랜잭션 안에서 실행된다(await 금지, tx 파사드만 사용).
 */

import { createBudgetGate } from './autonomy.js'
import { logActivity } from './activity-log.js'
import { normalizeProjectStatus, PROJECT_STATUS_CHANGE_ACTION, projectStatusChangeDetail } from './project-status.js'

const uuid = () => crypto.randomUUID()
const nowIso = () => new Date().toISOString()
// 프로젝트에 지정 에이전트(lead_agent_name)가 없을 때의 방어적 fallback(스폰 게이트가 보장하므로 거의 미도달).
const FALLBACK_AGENT = 'system'

/**
 * validateProposal — 워커 proposal 객체의 최소 스키마 검증(경계에서 끝냄).
 *
 * (설계 §5) next 신호를 함께 정규화한다. next='auto'(=다음 phase 자동집행 후보, 가역·저위험)만
 *   자동집행 후보이고, 'ask'/누락/그 외는 전부 'ask'(=항상 승인함)로 fail-safe 정규화한다.
 * @returns {{ok:true,value:{instruction,task_type,risk_level,next}} | {ok:false,reason:string}}
 */
function validateProposal(p) {
  if (p == null) return { ok: false, reason: 'null' }
  if (typeof p !== 'object') return { ok: false, reason: 'not_object' }
  const instruction = typeof p.instruction === 'string' ? p.instruction.trim() : ''
  if (!instruction) return { ok: false, reason: 'instruction_empty' }
  const task_type = typeof p.task_type === 'string' ? p.task_type.trim() : ''
  if (!task_type) return { ok: false, reason: 'task_type_empty' }
  let risk_level = typeof p.risk_level === 'string' ? p.risk_level.trim().toLowerCase() : 'low'
  if (!['low', 'medium', 'high', 'critical'].includes(risk_level)) risk_level = 'low'
  // fail-safe: 'auto' 만 자동집행 후보. 그 외(‘ask’·누락·오타·high/critical 방어)는 'ask'.
  const nextRaw = typeof p.next === 'string' ? p.next.trim().toLowerCase() : ''
  const next = nextRaw === 'auto' ? 'auto' : 'ask'
  return { ok: true, value: { instruction, task_type, risk_level, next } }
}

function insertMemory(tx, { project_id, memory_type, title, content, importance, agent_name }) {
  tx.prepare(
    `INSERT INTO memories (id, project_id, memory_type, title, content, importance, agent_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uuid(), project_id || null, memory_type, title, content || null, importance ?? 3, agent_name || null, nowIso()).run()
}

// activity_logs 단일 쓰기 관문(logActivity) 경유 — level/category 정규화 포함(system→telemetry).
function audit(tx, { project_id, action, detail }) {
  logActivity(tx, { project_id: project_id || null, agent_name: 'system', action, detail: detail || null, created_at: nowIso() })
}

/**
 * ingestCycleResultTx — 트랜잭션 콜백 본체(동기).
 *
 * @param {object} tx        동기 DB 파사드.
 * @param {object} command   project_cycle command 행(poll 이 done 처리한 뒤 넘긴 것).
 * @param {object} cycleJson 검증 전 파싱된 워커 JSON(=extractEmbeddedJson 결과값). 기대 형태:
 *                           { status, acted, summary, project_status?, proposal:{instruction,task_type,risk_level}|null }
 *                           project_status(선택): 워커의 라이프사이클 선언(pending/active/completed/on_hold).
 * @returns {object} 요약 리포트.
 */
export function ingestCycleResultTx(tx, command, cycleJson) {
  const projectId = command.project_id
  const report = {
    cycle_command_id: command.id,
    project_id: projectId,
    summary_recorded: false,
    proposal_created: false,
    proposal_command_id: null,
    proposal_status: null,
    proposal_locked: false,
    proposal_invalid: false,
    idempotent_noop: false,
    project_status_changed: null,
  }

  // 이 박동의 owner = 프로젝트의 지정 에이전트(lead_agent_name). 없으면 방어적 fallback.
  //   예산/비용/자율 게이트와 proposal command 의 비용 트리 귀속이 이 owner 기준.
  let leadAgent = FALLBACK_AGENT
  try {
    const proj = tx.prepare('SELECT lead_agent_name FROM projects WHERE id = ?').bind(projectId).first()
    if (proj?.lead_agent_name) leadAgent = proj.lead_agent_name
  } catch { /* fallback = LEAD_AGENT */ }

  // ── 멱등(§5.4): 이 cycle command 를 이미 적재했으면 no-op. ──
  //   활동로그 마커(action='cycle_ingest', detail 에 cmd=<id>)로 판정 → idle/proposal 양쪽 재시도 안전.
  const already = tx.prepare(
    `SELECT id FROM activity_logs WHERE action='cycle_ingest' AND detail LIKE ? LIMIT 1`
  ).bind(`%cmd=${command.id}%`).first()
  if (already) {
    report.idempotent_noop = true
    return report
  }

  const summary = (cycleJson && typeof cycleJson.summary === 'string') ? cycleJson.summary.trim() : ''
  const acted = !!(cycleJson && cycleJson.acted)

  // ── 1) summary → memories(KPI_INSIGHT) (관측성). summary 없으면 스킵. ──
  if (summary) {
    insertMemory(tx, {
      project_id: projectId,
      memory_type: 'KPI_INSIGHT',
      title: `프로젝트 박동 요약${acted ? '(수행)' : '(idle/제안)'}`,
      content: summary,
      importance: 3,
      agent_name: leadAgent,
    })
    report.summary_recorded = true
  }

  // ── 2) proposal 처리(있을 때만). ──
  const rawProposal = cycleJson ? cycleJson.proposal : null
  if (rawProposal != null) {
    const pv = validateProposal(rawProposal)
    if (!pv.ok) {
      report.proposal_invalid = true
      audit(tx, { project_id: projectId, action: 'cycle_proposal_reject', detail: `invalid proposal: ${pv.reason}` })
    } else {
      // 2-a) proposal 락(결정2 / §7-4 무한루프 방지): 살아있는 proposal command 가 이미 있으면 skip.
      //   멱등키 prefix 'cycle-...-proposal' + 미terminal 상태를 신호로 사용(§2.5 락과 동형).
      const livePrev = tx.prepare(
        `SELECT id FROM commands
           WHERE project_id=? AND status IN ('queued','approved','claimed','running')
             AND idempotency_key LIKE 'cycle-%-proposal' LIMIT 1`
      ).bind(projectId).first()
      if (livePrev) {
        report.proposal_locked = true
        audit(tx, { project_id: projectId, action: 'cycle_proposal_lock', detail: `살아있는 proposal command(${livePrev.id}) 존재 → 신규 생성 skip` })
      } else {
        const { instruction, task_type, risk_level, next } = pv.value
        // (설계 §5) proposal = "다음 실행단위". 실행 가능/held 는 proposal 의 next 신호가 가른다:
        //   - next='auto' + 게이트 통과(canAutoDispatch) → 'approved'(+reviewed_by='system-autonomy')
        //       로 자동 발행. 사람 승인분과 동일한 dispatch 경로(안전망 poll/즉시디스패치)로 다음 phase 이어짐.
        //   - next='auto' 지만 게이트 실패(자율 off/비용초과) → 'queued'(승인함 강등) + 사유 로그.
        //   - next='ask' 또는 필드 누락(validateProposal 이 'ask' 로 정규화) → 게이트 무관 항상 'queued'.
        //   ⚠️ 두 축 구분: acted="이번 턴에 직접 했나", next="다음 phase command 를 자동으로 돌릴까".
        //   구(舊) 주석의 "proposal 존재 자체=승인필요" 전제는 이 §5 로 폐기됐다(재정의).
        const gate = createBudgetGate(tx, projectId)
        const wantsAuto = next === 'auto'
        const auto = wantsAuto && gate.canAutoDispatch
        const status = auto ? 'approved' : 'queued'
        const review_status = auto ? 'approved' : null
        const reviewed_by = auto ? 'system-autonomy' : null
        const reviewed_at = auto ? nowIso() : null
        const permission_mode = 'allowlist'
        const idem = `cycle-${command.id}-proposal`
        const cmdId = uuid()
        const now = nowIso()
        try {
          // 실행 인프라 재설계(§1.4, v3 최종): task_id(상시 lead task 앵커) 대신 parent_command_id 로
          //   "이 proposal 이 어느 사이클(project_cycle command)에서 나왔나"를 직접 계보 기록한다.
          tx.prepare(
            `INSERT INTO commands (id, project_id, host, instruction, status, permission_mode, created_by,
                                   created_at, updated_at, idempotency_key, task_type, business, risk_level,
                                   parent_command_id, review_status, reviewed_by, reviewed_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, '업무', ?, ?, ?, ?, ?)`
          ).bind(cmdId, projectId, instruction, status, permission_mode, leadAgent,
            now, now, idem, task_type, risk_level, command.id, review_status, reviewed_by, reviewed_at).run()
          report.proposal_created = true
          report.proposal_command_id = cmdId
          report.proposal_status = status
          // 강등 사유: next='auto' 였는데 게이트가 막은 경우만(next='ask' 는 강등이 아니라 원래 정책).
          const demotedReason = (wantsAuto && !auto) ? gate.autoBlockReason() : null
          audit(tx, {
            project_id: projectId, action: 'cycle_proposal_create',
            detail: `제안 command 생성: ${task_type} next=${next} → ${status}${demotedReason ? ' (자동원했으나 강등:' + demotedReason + ')' : (auto ? ' (자동집행)' : '')}`,
          })
        } catch (e) {
          // 멱등키 충돌 = 이미 만든 proposal(재반영). 무시(중복 0).
          if (!/UNIQUE/i.test(e?.message || '')) throw e
          report.proposal_locked = true
        }
      }
    }
  }

  // ── 2.5) 워커의 라이프사이클 선언(선택) — 자율 워커는 MCP 를 못 부르므로(프롬프트 §0),
  //   완료/보류 등 라이프사이클 전이는 이 JSON 필드로 서버에 위임한다. MCP project_status_set 와
  //   동일 계약(lib/project-status.js)을 공유해 두 경로의 전이 규약이 갈라지지 않는다.
  //   무변경/무효값은 조용히 skip(감사로그 오염 방지). ──
  const declaredStatus = cycleJson ? normalizeProjectStatus(cycleJson.project_status) : null
  if (declaredStatus) {
    const cur = tx.prepare('SELECT status FROM projects WHERE id=?').bind(projectId).first()
    const prevStatus = cur?.status
    if (prevStatus && prevStatus !== declaredStatus) {
      tx.prepare('UPDATE projects SET status=? WHERE id=?').bind(declaredStatus, projectId).run()
      logActivity(tx, {
        project_id: projectId, agent_name: leadAgent,
        action: PROJECT_STATUS_CHANGE_ACTION,
        detail: projectStatusChangeDetail(prevStatus, declaredStatus, '자율 워커 선언'),
        created_at: nowIso(),
      })
      report.project_status_changed = `${prevStatus}→${declaredStatus}`
    }
  }

  // ── 3) 프로젝트 last_run_at 갱신(관측성). ──
  tx.prepare('UPDATE projects SET last_run_at=? WHERE id=?').bind(nowIso(), projectId).run()

  // ── 4) 멱등 마커 + 요약 감사로그. ──
  audit(tx, {
    project_id: projectId, action: 'cycle_ingest',
    detail: `cmd=${command.id} acted=${acted} proposal=${report.proposal_created ? report.proposal_status : (report.proposal_locked ? 'locked' : 'none')}`,
  })

  return report
}
