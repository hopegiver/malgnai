/**
 * resume-loop.js — §9 원격 승인 재개의 **다중 라운드** 지원(2026-07-06, §11 후속).
 *
 * 단일 라운드(승인→재개→완료)만 있던 것을 확장한다: 재개된 headless 워커가 답변을 반영한 뒤
 *   "또 대표 결정이 필요하다"고 판단하면, 같은 session_id 로 새 resume command 를 승인함(queued)에
 *   다시 올려 대표가 재차 답하고 워커가 또 이어받게 한다(§11 실측: resume 시 session_id 동일 유지).
 *
 * 신호 규약(우리가 재개 -p 프롬프트에 명시 주입): 재개 워커가 다음 라운드 승인이 필요하면
 *   응답 마지막에 정확히 아래 한 줄을 남긴다 →  NEEDS_APPROVAL: <한 줄 질문>
 *   그 줄이 있으면 그 질문을 instruction 으로 하는 새 resume command 를 큐잉한다. 없으면 종료(완료).
 *
 * 무한루프 차단: 한 세션당 resume 라운드 상한(MAX_RESUME_ROUNDS). 초과 시 재큐잉하지 않고 멈춘다
 *   (대표가 VSCode 에서 직접 확인하면 됨 — 수용된 태세).
 */

const MAX_RESUME_ROUNDS = 5
const NEEDS_APPROVAL_RE = /^\s*NEEDS_APPROVAL:\s*(.+?)\s*$/m
const DEFAULT_RESUME_ANSWER = '승인되었습니다. 이어서 진행하세요.'

/** 재개 워커에게 보낼 -p 프롬프트. 대표 답변(answer) + 다음 라운드 신호 규약을 함께 싣는다. */
export function buildResumePrompt(answer) {
  const body = (typeof answer === 'string' && answer.trim()) ? answer.trim() : DEFAULT_RESUME_ANSWER
  return [
    body,
    '',
    '(시스템 규약) 위 지시를 반영해 진행하라. 만약 진행 도중 다시 대표의 결정/승인이 꼭 필요해지면,',
    '응답의 맨 마지막 줄에 정확히 다음 형식 한 줄만 남겨라(그 외에는 남기지 마라):',
    'NEEDS_APPROVAL: <대표에게 물을 한 줄 질문>',
    '추가 승인이 필요 없으면 그 줄을 남기지 말고 그냥 마무리하라.',
  ].join('\n')
}

/** 워커 결과 텍스트에서 다음 라운드 신호를 파싱. @returns {{needs:boolean, question?:string}} */
export function parseResumeFollowup(resultText) {
  if (typeof resultText !== 'string') return { needs: false }
  const m = resultText.match(NEEDS_APPROVAL_RE)
  if (!m) return { needs: false }
  const question = m[1].trim()
  return question ? { needs: true, question } : { needs: false }
}

/**
 * maybeRequeueResumeTx — 완료된 resume command 의 결과를 보고, 다음 라운드가 필요하면 새 resume
 *   command 를 queued 로 INSERT 한다(동기 tx 내부). resume 가 아니거나 신호 없으면 no-op.
 * @returns {{requeued:boolean, reason?:string, newId?:string}}
 */
export function maybeRequeueResumeTx(tx, command, resultText) {
  if (!command || command.task_type !== 'resume' || !command.session_id) return { requeued: false }
  const { needs, question } = parseResumeFollowup(resultText)
  if (!needs) return { requeued: false }

  // 세션당 라운드 상한 — 무한 재큐잉 차단.
  const cnt = tx.prepare(
    `SELECT COUNT(*) n FROM commands WHERE session_id=? AND task_type='resume'`
  ).bind(command.session_id).first()
  if (cnt && Number(cnt.n) >= MAX_RESUME_ROUNDS) {
    return { requeued: false, reason: `max resume rounds(${MAX_RESUME_ROUNDS}) reached` }
  }

  const now = new Date().toISOString()
  const newId = crypto.randomUUID()
  tx.prepare(
    `INSERT INTO commands (id, project_id, instruction, status, permission_mode, created_by,
                           session_id, task_type, risk_level, title, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 'allowlist', 'system-resume-loop', ?, 'resume', 'medium', ?, ?, ?)`
  ).bind(newId, command.project_id, question, command.session_id,
    `[재개 후속] ${question.slice(0, 80)}`, now, now).run()
  return { requeued: true, newId }
}

/** 비-tx db 파사드용 래퍼 — 즉시디스패치/PATCH 결과 경로에서 호출. 실패는 삼킨다(best-effort). */
export function maybeRequeueResume(db, command, resultText) {
  try {
    return db.transaction((tx) => maybeRequeueResumeTx(tx, command, resultText))
  } catch {
    return { requeued: false, reason: 'requeue tx failed' }
  }
}
