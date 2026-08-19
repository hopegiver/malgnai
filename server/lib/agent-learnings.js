// agent_learnings(agent_learning_record) 공통 구현 — 불변 이력, 매번 새 행 INSERT
// (decisions.js와 동일 철학, schema.sql §3.16). project_id가 아니라 user_id가 1차 소유권이다
// (architecture.md §0 결정21) — 에이전트는 프로젝트가 아니라 사람에게 속하고 여러 프로젝트를
// 넘나든다. projectId가 주어졌을 때만 mcp/agent.js의 resolveProjectById()로 본인 소유가 맞는지
// 확인해 "계기가 된 프로젝트" 참조로 넘겨받고, 생략되면 projectId는 null.
import { newId } from './ulid.js'
import { parseIdempotencyKey } from './idempotency.js'

const TYPES = ['experience', 'external', 'peer_feedback', 'discussion']

function validationError(message) {
  const e = new Error(message)
  e.name = 'ValidationError'
  return e
}

/** agent_learning_record(mcp-tools.md §4.12). idempotency_key UNIQUE 위반(재전송) 시 기존 행을
 *  그대로 반환(decisions.js와 동일 catch-retry 패턴). */
export async function recordAgentLearning(db, { userId, agentName, projectId, type, title, content, source, idempotencyKey }) {
  if (!idempotencyKey) throw validationError('idempotencyKey is required')
  if (!agentName || typeof agentName !== 'string') throw validationError('agentName is required')
  if (!TYPES.includes(type)) throw validationError(`type must be one of ${TYPES.join(',')}`)
  if (!title || title.length < 1 || title.length > 200) throw validationError('title must be 1..200 chars')
  if (!content || content.length < 1 || content.length > 2000) throw validationError('content must be 1..2000 chars')

  const existing = await db.prepare('SELECT * FROM agent_learnings WHERE idempotency_key = ?').bind(idempotencyKey).first()
  if (existing) return { id: existing.id, createdAt: existing.created_at }

  const { sessionId } = parseIdempotencyKey(idempotencyKey)
  const id = newId()
  const now = new Date().toISOString()

  try {
    await db.prepare(
      `INSERT INTO agent_learnings (id, user_id, agent_name, project_id, type, title, content, source, session_id, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, userId, agentName, projectId || null, type, title, content, source || null, sessionId, idempotencyKey, now).run()
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      const row = await db.prepare('SELECT * FROM agent_learnings WHERE idempotency_key = ?').bind(idempotencyKey).first()
      if (row) return { id: row.id, createdAt: row.created_at }
    }
    throw e
  }
  return { id, createdAt: now }
}

/** agent_get_context용(mcp-tools.md §4.14) — user_id+agent_name으로 최신순 N개. */
export async function listRecentForAgent(db, userId, agentName, limit = 10) {
  const { results } = await db.prepare(
    'SELECT * FROM agent_learnings WHERE user_id = ? AND agent_name = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(userId, agentName, limit).all()
  return results
}
