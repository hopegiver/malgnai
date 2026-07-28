// decisions(decision_record) 공통 구현 — 불변 이력, 매번 새 행 INSERT(architecture.md §0-11).
// alternatives/reversalCondition은 별도 컬럼이 없어 reason 텍스트에 서술로 흡수하고,
// impact(string[])는 스키마의 impact TEXT 컬럼에 그대로 저장한다(§3.4 — "구조화 배열은 두지 않는다"
// 원칙과 impact 컬럼이 이미 존재한다는 사실을 함께 반영한 판단).
import { newId } from './ulid.js'
import { parseIdempotencyKey } from './idempotency.js'

function validationError(message) {
  const e = new Error(message)
  e.name = 'ValidationError'
  return e
}

export async function recordDecision(db, { userId, projectId, title, decision, reason, alternatives, impact, reversalCondition, importance = 3, idempotencyKey }) {
  if (!idempotencyKey) throw validationError('idempotencyKey is required')
  if (!title || title.length < 1 || title.length > 200) throw validationError('title must be 1..200 chars')
  if (!decision || decision.length > 2000) throw validationError('decision must be 1..2000 chars')
  if (!reason || reason.length > 2000) throw validationError('reason must be 1..2000 chars')
  const imp = Number.isInteger(importance) ? importance : 3
  if (imp < 1 || imp > 5) throw validationError('importance must be 1..5')

  const existing = await db.prepare('SELECT * FROM decisions WHERE idempotency_key = ?').bind(idempotencyKey).first()
  if (existing) return { decisionId: existing.id, createdAt: existing.created_at }

  let reasonText = reason
  if (Array.isArray(alternatives) && alternatives.length) {
    reasonText += `\n\n[대안]\n${alternatives.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
  }
  if (reversalCondition) {
    reasonText += `\n\n[되돌림 조건] ${reversalCondition}`
  }
  reasonText = reasonText.slice(0, 2000)
  const impactText = Array.isArray(impact) && impact.length ? impact.join('\n').slice(0, 2000) : null

  const { sessionId } = parseIdempotencyKey(idempotencyKey)
  const id = newId()
  const now = new Date().toISOString()

  try {
    await db.prepare(
      `INSERT INTO decisions (id, project_id, user_id, title, summary, reason, impact, importance, session_id, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, projectId, userId, title, decision, reasonText, impactText, imp, sessionId, idempotencyKey, now).run()
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      const row = await db.prepare('SELECT * FROM decisions WHERE idempotency_key = ?').bind(idempotencyKey).first()
      if (row) return { decisionId: row.id, createdAt: row.created_at }
    }
    throw e
  }
  return { decisionId: id, createdAt: now }
}

/** project_get_context용 — importance 내림차순, 최근순(§4.1). */
export async function listTopForContext(db, projectId, limit = 10) {
  const { results } = await db.prepare(
    'SELECT * FROM decisions WHERE project_id = ? ORDER BY importance DESC, created_at DESC LIMIT ?'
  ).bind(projectId, limit).all()
  return results
}

/** 커서 기반 목록 조회(next_cursor=id — api.md §5.4). importance_min 필터 지원. */
export async function listDecisions(db, projectId, { cursor, limit = 20, importanceMin } = {}) {
  const params = [projectId]
  let sql = 'SELECT * FROM decisions WHERE project_id = ?'
  if (importanceMin) {
    sql += ' AND importance >= ?'
    params.push(importanceMin)
  }
  if (cursor) {
    sql += ' AND id < ?'
    params.push(cursor)
  }
  sql += ' ORDER BY id DESC LIMIT ?'
  params.push(limit + 1)
  const { results } = await db.prepare(sql).bind(...params).all()
  const hasMore = results.length > limit
  const page = hasMore ? results.slice(0, limit) : results
  return { data: page, next_cursor: hasMore ? page[page.length - 1].id : null }
}
