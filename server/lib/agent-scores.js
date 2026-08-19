// agent_scores(agent_score_record) 공통 구현 — 불변 이력, 매번 새 행 INSERT
// (decisions.js와 동일 철학, schema.sql §3.16). project_id가 아니라 user_id가 1차 소유권이다
// (architecture.md §0 결정21). dimensionScores는 evaluator/스코어카드 기준마다 컬럼 구성이
// 달라질 수 있어 JSON 직렬화해 저장(≤4KB — works.links_json과 동일하게 앱단에서 검증,
// mcp-tools.md §4.13).
import { newId } from './ulid.js'
import { parseIdempotencyKey } from './idempotency.js'

const MAX_DIMENSION_SCORES_BYTES = 4 * 1024

function validationError(message) {
  const e = new Error(message)
  e.name = 'ValidationError'
  return e
}

function byteLength(str) {
  return new TextEncoder().encode(str).length
}

/** agent_score_record(mcp-tools.md §4.13). idempotency_key UNIQUE 위반(재전송) 시 기존 행을
 *  그대로 반환(decisions.js와 동일 catch-retry 패턴). */
export async function recordAgentScore(db, { userId, agentName, projectId, overallScore, dimensionScores, improvementNote, evaluatorNote, idempotencyKey }) {
  if (!idempotencyKey) throw validationError('idempotencyKey is required')
  if (!agentName || typeof agentName !== 'string') throw validationError('agentName is required')
  if (typeof overallScore !== 'number' || Number.isNaN(overallScore) || overallScore < 0 || overallScore > 100) {
    throw validationError('overallScore must be a number 0..100')
  }
  if (improvementNote != null && String(improvementNote).length > 2000) throw validationError('improvementNote must be <= 2000 chars')
  if (evaluatorNote != null && String(evaluatorNote).length > 2000) throw validationError('evaluatorNote must be <= 2000 chars')

  let dimensionScoresJson = null
  if (dimensionScores != null) {
    if (typeof dimensionScores !== 'object' || Array.isArray(dimensionScores)) {
      throw validationError('dimensionScores must be an object')
    }
    dimensionScoresJson = JSON.stringify(dimensionScores)
    if (byteLength(dimensionScoresJson) > MAX_DIMENSION_SCORES_BYTES) {
      throw validationError('dimensionScores must be <= 4KB when serialized')
    }
  }

  const existing = await db.prepare('SELECT * FROM agent_scores WHERE idempotency_key = ?').bind(idempotencyKey).first()
  if (existing) return { id: existing.id, createdAt: existing.created_at }

  const { sessionId } = parseIdempotencyKey(idempotencyKey)
  const id = newId()
  const now = new Date().toISOString()

  try {
    await db.prepare(
      `INSERT INTO agent_scores (id, user_id, agent_name, project_id, overall_score, dimension_scores, improvement_note, evaluator_note, session_id, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      userId,
      agentName,
      projectId || null,
      overallScore,
      dimensionScoresJson,
      improvementNote != null ? String(improvementNote).slice(0, 2000) : null,
      evaluatorNote != null ? String(evaluatorNote).slice(0, 2000) : null,
      sessionId,
      idempotencyKey,
      now
    ).run()
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      const row = await db.prepare('SELECT * FROM agent_scores WHERE idempotency_key = ?').bind(idempotencyKey).first()
      if (row) return { id: row.id, createdAt: row.created_at }
    }
    throw e
  }
  return { id, createdAt: now }
}

/** agent_get_context용(mcp-tools.md §4.14) — 최신 1행. */
export async function getLatestForAgent(db, userId, agentName) {
  const row = await db.prepare(
    'SELECT * FROM agent_scores WHERE user_id = ? AND agent_name = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(userId, agentName).first()
  return row || null
}

/** agent_get_context용(mcp-tools.md §4.14) — overallScore+createdAt 추이용 최신순 N개. */
export async function listHistoryForAgent(db, userId, agentName, limit = 10) {
  const { results } = await db.prepare(
    'SELECT overall_score, created_at FROM agent_scores WHERE user_id = ? AND agent_name = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(userId, agentName, limit).all()
  return results
}
