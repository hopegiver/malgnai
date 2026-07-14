/**
 * worker-ingest.js — WORKER/CYCLE 결과 파싱 유틸 + 실행 실패 최소 적재. 트랜잭션 안에서 동기 실행.
 *
 * ⚠️ 실행 인프라 재설계(execution-infra-redesign.md §1.4, v3 최종): 구 `ingestWorkerResultTx`
 *   (commands.task_id → tasks UPDATE + lessons[]/next_task_suggestions[]→memories 추출)는
 *   **폐기**됐다(리라이트 아님). task_id 를 채우던 유일한 두 코드 경로(상시 lead task 앵커의
 *   project_cycle INSERT, cycle-ingest.js 의 proposal INSERT)가 §1.4 로 각각 제거·대체되어
 *   task_id 가 채워지는 경로가 전무해졌고, 그 결과 이 경로(및 POST /api/lead/worker-result)는
 *   재현 불가능한 죽은 코드가 됐다. 필요해지면 "모든 완료 커맨드가 stdout 을 WORKER-shape 로
 *   재시도 파싱해 lessons 를 뽑는" 범용 후크로 **task_id 링크 없이** 다시 붙인다(후속 과제).
 */

import { logActivity } from './activity-log.js'
import { taskTypeToCategory } from './activity-normalize.js'

// ── 공유 결과 파싱 유틸(구 lead-json.js 에서 이관) ──────────────────────────────
//   distributed 결과 적재 라우트(worker-result, cycle-result)가 공유한다. central
//   전용 검증기(validateLeadJson/validateLeadChildItem)는 central 제거와 함께 삭제됐다.

function tryParse(s) {
  try { return JSON.parse(s) } catch { return undefined }
}

/**
 * extractEmbeddedJson — 입력이 무엇이든(객체/래퍼/문자열/앞뒤 설명 포함) WORKER/CYCLE 객체를 추출.
 *
 * 처리 순서:
 *  1) 이미 객체이고 claude 래퍼가 아니면 그대로 반환.
 *  2) 객체인데 claude 래퍼({result, total_cost_usd,...})면 .result 문자열을 2차 파싱.
 *  3) 문자열이면: 통째 JSON.parse 시도 → 실패 시 첫 '{' ~ 마지막 '}' 슬라이스 후 JSON.parse.
 *
 * @returns {{ ok:true, value:object } | { ok:false, error:string }}
 */
export function extractEmbeddedJson(input) {
  if (input == null) return { ok: false, error: 'EMPTY_INPUT' }

  // 1·2) 객체로 들어온 경우.
  if (typeof input === 'object') {
    // claude 래퍼인지: result 문자열만 가진(WORKER/CYCLE 키 없는) 형태.
    if (typeof input.result === 'string' && input.tasks_to_create === undefined && input.summary === undefined && input.actions_taken === undefined) {
      return extractEmbeddedJson(input.result)
    }
    return { ok: true, value: input }
  }

  if (typeof input !== 'string') return { ok: false, error: 'UNSUPPORTED_INPUT_TYPE' }

  const raw = input.trim()
  if (!raw) return { ok: false, error: 'EMPTY_STRING' }

  // 3) 문자열: 통째 파싱 우선.
  let parsed = tryParse(raw)
  if (parsed === undefined) {
    // 앞뒤 설명문이 붙은 경우: 첫 '{' ~ 마지막 '}' 슬라이스.
    const first = raw.indexOf('{')
    const last = raw.lastIndexOf('}')
    if (first === -1 || last === -1 || last <= first) {
      return { ok: false, error: 'NO_JSON_OBJECT_FOUND' }
    }
    parsed = tryParse(raw.slice(first, last + 1))
    if (parsed === undefined) return { ok: false, error: 'JSON_PARSE_FAILED' }
  }

  // 파싱 결과가 claude 래퍼면 한 번 더 푼다(2단 파싱).
  if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string'
      && parsed.tasks_to_create === undefined && parsed.summary === undefined && parsed.actions_taken === undefined) {
    return extractEmbeddedJson(parsed.result)
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'NOT_AN_OBJECT' }
  return { ok: true, value: parsed }
}

/**
 * ingestCommandFailureTx — claude 프로세스 자체가 비정상 종료(exit_code≠0)했을 때의 최소 적재.
 *   WORKER/CYCLE JSON 파싱 이전 단계의 실패라 activity_log 기록과(있다면) task 종료 처리만 한다.
 *   worker-result 의 WORKER_JSON_PARSE_FAILED 분기와 동형이나, stdout 자체가 없거나 파싱 대상이
 *   아닌 project_cycle 실패까지 포괄하는 상위 경로(poll-commands.js exitCode≠0 전용).
 * @param {object} tx        동기 DB 파사드.
 * @param {object} command   실패한 command 행.
 * @param {string} errorMsg  stderr/spawn error(이미 poll 단에서 truncate됨).
 * @returns {object} 리포트.
 */
export function ingestCommandFailureTx(tx, command, errorMsg) {
  const report = { command_id: command.id, task_updated: false, idempotent_noop: false }

  // 멱등: 이 command 의 실패를 이미 기록했으면 재기록 안 함(재전송/재시도 안전).
  const already = tx.prepare(
    `SELECT id FROM activity_logs WHERE action='command_fail' AND detail LIKE ? LIMIT 1`
  ).bind(`%cmd=${command.id}%`).first()
  if (already) { report.idempotent_noop = true; return report }

  logActivity(tx, {
    project_id: command.project_id || null,
    agent_name: command.created_by || 'system',
    action: 'command_fail',
    detail: `cmd=${command.id} task_type=${command.task_type || ''} error=${errorMsg || '(no error message)'}`,
    level: 'work',
    category: taskTypeToCategory(command.task_type),
    result: 'failed',
    title: `${command.task_type || '작업'} 실패`,
  })

  return report
}
