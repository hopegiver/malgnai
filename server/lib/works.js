// works(work_record) 공통 구현 — MCP 도구(mcp/agent.js)와 REST 재전송(POST /api/events/batch,
// v1 미구현)이 둘 다 이 함수를 호출한다(architecture.md §2.1 재사용 원칙).
import { newId } from './ulid.js'
import { parseIdempotencyKey } from './idempotency.js'

const VALID_STATUS = ['started', 'progress', 'completed', 'blocked']
const MAX_ARTIFACTS = 20
const MAX_ARTIFACT_LEN = 300

function validationError(message) {
  const e = new Error(message)
  e.name = 'ValidationError'
  return e
}

export async function recordWork(db, { userId, projectId, status, title, summary, reason, result, artifacts, nextAction, idempotencyKey }) {
  if (!idempotencyKey) throw validationError('idempotencyKey is required')
  if (!VALID_STATUS.includes(status)) throw validationError(`status must be one of ${VALID_STATUS.join(',')}`)
  if (!title || title.length < 1 || title.length > 200) throw validationError('title must be 1..200 chars')
  if (summary && summary.length > 2000) throw validationError('summary must be <= 2000 chars')
  if (nextAction && String(nextAction).length > 2000) throw validationError('nextAction must be <= 2000 chars')

  const artifactList = Array.isArray(artifacts) ? artifacts : []
  if (artifactList.length > MAX_ARTIFACTS) throw validationError(`artifacts must be <= ${MAX_ARTIFACTS} items`)
  for (const a of artifactList) {
    if (typeof a !== 'string' || a.length > MAX_ARTIFACT_LEN) throw validationError('each artifact must be a string <= 300 chars')
  }

  const existing = await db.prepare('SELECT * FROM works WHERE idempotency_key = ?').bind(idempotencyKey).first()
  if (existing) return { workId: existing.id, createdAt: existing.created_at }

  const { sessionId } = parseIdempotencyKey(idempotencyKey)
  const detail = [summary, reason].filter(Boolean).join('\n\n').slice(0, 2000) || null
  const targetRef = artifactList[0] || null
  const linksJson = artifactList.length ? JSON.stringify(artifactList) : null
  const nextActionText = nextAction ? String(nextAction).slice(0, 2000) : null
  const id = newId()
  const now = new Date().toISOString()

  try {
    await db.prepare(
      `INSERT INTO works (id, project_id, user_id, category, title, detail, target_ref, result, links_json, next_action, session_id, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, projectId, userId, status, title, detail, targetRef, result ? String(result).slice(0, 2000) : null, linksJson, nextActionText, sessionId, idempotencyKey, now).run()
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      const row = await db.prepare('SELECT * FROM works WHERE idempotency_key = ?').bind(idempotencyKey).first()
      if (row) return { workId: row.id, createdAt: row.created_at }
    }
    throw e
  }
  return { workId: id, createdAt: now }
}

/** 커서 기반 목록 조회(next_cursor=id, ULID 시간정렬 — api.md §5.4). */
export async function listWorks(db, projectId, { cursor, limit = 20, category } = {}) {
  const params = [projectId]
  let sql = 'SELECT * FROM works WHERE project_id = ?'
  if (category) {
    sql += ' AND category = ?'
    params.push(category)
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
