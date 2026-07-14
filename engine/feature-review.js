/**
 * engine/feature-review.js — 기능 개선 요청 완전자동 심사(사람 승인 개입 없음).
 *
 * engine/run.js 가 매 틱 runSpawnDue 이후·safetyPollOnce 이전에 이 함수를 호출한다. 로직은
 *   engine/safety-poll.js 와 동형(claim → claude 실행 → 결과 반영)이지만 대상 큐가 commands 가
 *   아니라 feature_requests 다. 승인되면 memories(FEEDBACK) 에 적재해 기존 project_cycle 이
 *   다음 자율 사이클에서 그대로 반영하게 한다(신규 실행 파이프라인 없음 — 기존 project_cycle →
 *   승인함 게이트 재사용).
 *
 * 재사용(복제 금지):
 *  - claim/결과반영: server/dao/feature-requests.js 의 FeatureRequestsDao.
 *  - claude 실행: server/lib/worker-exec.js 의 runClaude/parseClaudeJson/truncate.
 *  - JSON 추출: server/lib/worker-ingest.js 의 extractEmbeddedJson(project_cycle/safety-poll 과
 *    동일 관례 — 객체/claude 래퍼/앞뒤 설명 섞인 문자열 전부 처리).
 *  - 심사 프롬프트: server/lib/feature-review-prompt.js 의 buildFeatureReviewPrompt.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import FeatureRequestsDao from '../server/dao/feature-requests.js'
import ProjectsDao from '../server/dao/projects.js'
import { runClaude, parseClaudeJson, truncate } from '../server/lib/worker-exec.js'
import { extractEmbeddedJson } from '../server/lib/worker-ingest.js'
import { buildFeatureReviewPrompt } from '../server/lib/feature-review-prompt.js'
import { ROOT } from './db.js'

// 심사는 순수 판단(코드 수정 없음)이라 project_cycle(15분/무제한 턴)보다 훨씬 가볍게 예산을 잡는다.
export const FEATURE_REVIEW_MAX_TURNS = 4

// reviewer 지적(Major, 2026-07-14): claimNextPending()은 항상 "가장 오래된 pending"을 집기 때문에,
// 실행/파싱이 구조적으로 계속 실패하는 요청 1건이 상한 없이 pending으로 되돌아가면 그 뒤의 모든
// pending 요청이 무기한 밀린다. 이 횟수를 넘기면 재시도 대신 종결(rejected) 처리한다.
export const MAX_REVIEW_ATTEMPTS = 3

const LOG_DIR = join(ROOT, 'logs')
const LOG_FILE = join(LOG_DIR, 'engine.log')

function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), source: 'feature-review', ...obj })
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line + '\n')
  } catch { /* 로깅 실패는 무시 */ }
  console.log('[engine:feature-review]', line)
}

/**
 * recordFailureAndMaybeGiveUp — 실행/파싱 실패 1건을 기록한다. review_attempts가 MAX_REVIEW_ATTEMPTS
 *   미만이면 'pending'으로 되돌려 다음 틱 재시도, 도달하면 'rejected'로 종결해 이 요청이 큐 맨 앞을
 *   영구 점유하는 것을 막는다(claimNextPending()이 항상 "가장 오래된 pending"을 집기 때문).
 * @returns {Promise<{outcome:'retry'|'processed', featureRequestId:string, decision?:'rejected'}>}
 */
async function recordFailureAndMaybeGiveUp(dao, fr, event, error) {
  const attempts = (fr.review_attempts || 0) + 1
  if (attempts >= MAX_REVIEW_ATTEMPTS) {
    const reviewedAt = new Date().toISOString()
    await dao.updateReview(fr.id, {
      status: 'rejected',
      review_reason: `반복 심사 실패로 자동 반려됨(${attempts}회 시도)`,
      reviewed_at: reviewedAt,
      review_attempts: attempts,
    })
    logLine({ event: `${event}_giveup`, feature_request_id: fr.id, attempts, error })
    return { outcome: 'processed', featureRequestId: fr.id, decision: 'rejected' }
  }
  await dao.updateReview(fr.id, { status: 'pending', review_reason: null, reviewed_at: null, review_attempts: attempts })
  logLine({ event, feature_request_id: fr.id, attempts, error })
  return { outcome: 'retry', featureRequestId: fr.id }
}

/**
 * reviewFeatureRequestsOnce — 큐 1건 claim→심사→결과반영.
 * @param {object} db  D1 호환 어댑터(better-sqlite3 wrap 또는 테스트용 인메모리).
 * @returns {Promise<{outcome:'idle'}
 *   |{outcome:'processed', featureRequestId:string, decision:'approved'|'rejected'}
 *   |{outcome:'retry', featureRequestId:string}>}
 */
export async function reviewFeatureRequestsOnce(db) {
  const dao = new FeatureRequestsDao(db)

  // 1) claim — 가장 오래된 pending 1건을 원자적으로 점유(단일 statement 조건부 UPDATE, §DAO).
  const fr = await dao.claimNextPending()
  if (!fr) {
    logLine({ event: 'idle', message: 'no feature request to review' })
    return { outcome: 'idle' }
  }

  const projectsDao = new ProjectsDao(db)
  const project = fr.project_id ? await projectsDao.findById(fr.project_id) : null

  // 2) project 가 없거나 cwd 가 없으면 심사 자체가 불가능 — 무한 재시도 대신 즉시 반려로 종결한다
  //    (engine/safety-poll.js 의 동일 가드와 달리 이쪽은 'pending' 되돌리기가 상태 자체를 아예
  //    실행 불가능한 상태로 무한 순환시키므로, 구조적 실패는 종결 상태로 확정한다).
  if (!project || !project.path) {
    const reviewedAt = new Date().toISOString()
    await dao.updateReview(fr.id, {
      status: 'rejected',
      review_reason: '프로젝트를 찾을 수 없거나 경로가 없어 심사가 불가능해 자동 반려됨',
      reviewed_at: reviewedAt,
    })
    logLine({ event: 'rejected', feature_request_id: fr.id, reason: 'project not found or missing path' })
    return { outcome: 'processed', featureRequestId: fr.id, decision: 'rejected' }
  }

  const prompt = buildFeatureReviewPrompt(project, fr)
  const { exitCode, stdout, stderr, spawnError } = await runClaude(
    prompt, project.path, FEATURE_REVIEW_MAX_TURNS, null, 'none'
  )
  const parsed = parseClaudeJson(stdout)

  // 3) claude 프로세스 자체가 비정상 종료 — MAX_REVIEW_ATTEMPTS 미만이면 다음 틱 재시도, 도달하면 종결.
  if (exitCode !== 0 || spawnError) {
    return await recordFailureAndMaybeGiveUp(
      dao, fr, 'exec_failed',
      spawnError || truncate(parsed.cliError || stderr || 'non-zero exit', 500)
    )
  }

  // 4) {"decision":"approve"|"reject","reason":"..."} 추출. 실패/형식불량도 동일 재시도 상한 적용.
  const extracted = extractEmbeddedJson(parsed.result ?? stdout)
  const decisionRaw = extracted.ok ? extracted.value?.decision : null
  if (!extracted.ok || !['approve', 'reject'].includes(decisionRaw)) {
    return await recordFailureAndMaybeGiveUp(
      dao, fr, 'parse_failed',
      extracted.ok ? `invalid decision field: ${JSON.stringify(decisionRaw)}` : extracted.error
    )
  }

  const reason = typeof extracted.value.reason === 'string' ? truncate(extracted.value.reason, 2000) : null
  const status = decisionRaw === 'approve' ? 'approved' : 'rejected'
  const reviewedAt = new Date().toISOString()
  await dao.updateReview(fr.id, { status, review_reason: reason, reviewed_at: reviewedAt })

  // 5) 승인 시에만 memories(FEEDBACK) 적재 — engine/spawn.js 가 project_cycle 스폰마다 무조건
  //    조회해 워커 프롬프트 최상단에 강제 주입하는 기존 경로를 그대로 재사용(신규 배선 0).
  if (status === 'approved') {
    try {
      await db.prepare(
        `INSERT INTO memories (id, project_id, memory_type, title, content, importance, agent_name, created_at)
         VALUES (?, ?, 'FEEDBACK', ?, ?, 4, 'system-feature-review', ?)`
      ).bind(
        crypto.randomUUID(),
        fr.project_id,
        `[승인된 기능요청] ${fr.title}`,
        `[승인된 기능요청] ${fr.description || fr.title}`,
        reviewedAt,
      ).run()
    } catch (e) {
      logLine({ event: 'memory_insert_failed', feature_request_id: fr.id, error: e.message })
    }
  }

  logLine({ event: 'processed', feature_request_id: fr.id, decision: status, cost: parsed.cost_usd, reason })
  return { outcome: 'processed', featureRequestId: fr.id, decision: status }
}
