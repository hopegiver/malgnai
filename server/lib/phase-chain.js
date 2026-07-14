/**
 * phase-chain.js — 웹앱 "직접 명령"(사람 직접 지시, 무제한 턴)의 **단계(phase) 자동 이어달리기**.
 *
 * worker-exec.js 의 STAGED_EXECUTION_PROMPT 가 사람 직접 명령(task_type이 'project_cycle'도
 *   'resume'도 아닌 모든 무제한 턴 명령)에 "작업이 크면 단계로 나누고, 이번 세션은 한 단계만
 *   끝내고 다음 단계 지시를 결과 마지막에 `NEXT_PHASE: <지시>` 로 남겨라" 라고 지시한다. 이 모듈은
 *   그 신호를 파싱해 다음 단계 command 를 만든다.
 *
 * §9 resume(NEEDS_APPROVAL)과의 차이: resume 은 "사람 판단이 다시 필요하다"는 신호라 승인함에
 *   'queued'로 올라가 대표 재승인을 기다린다. 여기서는 사람이 원 명령을 이미 승인/직접실행했고
 *   단순히 "토큰 절약을 위해 세션을 쪼갠 것"뿐이므로, 다음 단계는 재승인 없이 'approved'(자가승인)
 *   로 생성하고 §7 active-1 불변식을 지키며 즉시 클레임을 시도한다(claimApprovedForProject 재사용
 *   — 원 명령이 아직 종결 전이라 클레임이 실패하면 'approved'로 남아 안전망 poll 이 집어간다).
 */

import { claimApprovedForProject } from './instant-dispatch.js'

const uuid = () => crypto.randomUUID()
const nowIso = () => new Date().toISOString()

// 체인당 최대 단계 수 상한 (과도한 연쇄 실행 방지)
export const MAX_PHASE_ROUNDS = 20

const NEXT_PHASE_RE = /^NEXT_PHASE:\s*([\s\S]+)$/m

/** 워커 결과 텍스트에서 다음 단계 신호를 파싱. @returns {{needs:boolean, instruction?:string}} */
export function parsePhaseFollowup(resultText) {
  if (typeof resultText !== 'string') return { needs: false }
  const m = resultText.match(NEXT_PHASE_RE)
  if (!m) return { needs: false }
  const instruction = m[1].trim()
  return instruction ? { needs: true, instruction } : { needs: false }
}

/**
 * maybeRequeuePhaseTx — 완료된 command 의 결과를 보고, 다음 단계가 필요하면 새 command 를
 *   'approved'(자가승인)로 생성하고 즉시 타겟클레임을 시도한다(동기 tx 내부).
 *
 * 적용 대상: task_type 이 'project_cycle'(자율 사이클 전용 next='auto' proposal 체계를 이미 가짐),
 *   'resume'(§9, 별도 NEEDS_APPROVAL 체계를 이미 가짐), 'console'(Claude Code 웹콘솔, 2026-07-09 —
 *   사람과 실시간 멀티턴 채팅 중이라 매 턴 끝에 다음 단계 command 가 자동 생성·실행되면 채팅 흐름과
 *   충돌한다) 그 어느 것도 아닌 모든 command — 그 외는 호출부가 따로 걸러내지 않아도 이 함수가 즉시
 *   no-op 한다(호출부 조건 중복 방지).
 *
 * @returns {{requeued:boolean, reason?:string, newId?:string, claimed?:boolean}}
 */
export function maybeRequeuePhaseTx(tx, command, resultText) {
  if (!command || command.task_type === 'project_cycle' || command.task_type === 'resume' || command.task_type === 'console') {
    return { requeued: false }
  }
  const { needs, instruction } = parsePhaseFollowup(resultText)
  if (!needs) return { requeued: false }

  const rootId = command.root_command_id || command.id
  const level = (Number(command.level) || 0) + 1

  // 체인당 라운드 상한 — 같은 root 아래 이미 만들어진 후속 단계 수로 판정(무한 재생성 차단).
  const cnt = tx.prepare(`SELECT COUNT(*) n FROM commands WHERE root_command_id = ?`).bind(rootId).first()
  if (cnt && Number(cnt.n) >= MAX_PHASE_ROUNDS) {
    return { requeued: false, reason: `max phase rounds(${MAX_PHASE_ROUNDS}) reached` }
  }

  const idem = `phase-${command.id}-next`
  const newId = uuid()
  const now = nowIso()
  try {
    tx.prepare(
      `INSERT INTO commands (
         id, project_id, host, instruction, status, permission_mode, created_by,
         created_at, updated_at, idempotency_key, task_type, risk_level, title,
         parent_command_id, root_command_id, level,
         review_status, reviewed_by, reviewed_at
       ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      newId,
      command.project_id,
      instruction,
      'approved',
      command.permission_mode || 'allowlist',
      'system-phase-chain',
      now,
      now,
      idem,
      command.task_type || null,
      command.risk_level || 'low',
      `[다음 단계] ${instruction.slice(0, 80)}`,
      command.id,
      rootId,
      level,
      'approved',
      'system-phase-chain',
      now,
    ).run()
  } catch (e) {
    // 멱등키 충돌 = 이 command 에서 이미 다음 단계를 만들었다(재반영 안전, 중복 0).
    if (!/UNIQUE/i.test(e?.message || '')) throw e
    return { requeued: false, reason: 'already chained' }
  }

  // 원 명령이 아직 'running'이면(호출부가 상태 갱신 전에 부를 수도 있어) 클레임이 실패할 수
  //   있다 — 정상. 그 경우 'approved'로 남아 안전망 poll 이 프로젝트가 비는 대로 집어간다(§7).
  const claimed = claimApprovedForProject(tx, newId, 'server-phase-chain')
  return { requeued: true, newId, claimed }
}

/** 비-tx db 파사드용 래퍼 — 즉시디스패치/PATCH 결과 경로에서 호출. 실패는 삼킨다(best-effort). */
export function maybeRequeuePhase(db, command, resultText) {
  try {
    return db.transaction((tx) => maybeRequeuePhaseTx(tx, command, resultText))
  } catch {
    return { requeued: false, reason: 'requeue tx failed' }
  }
}
