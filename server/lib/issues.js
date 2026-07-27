// issues(record_issue) 공통 구현 — open 시 INSERT, updated/resolved 시 같은 PK 행을 UPDATE
// (architecture.md §0-11, mcp-tools.md §4.4).
//
// [설계 판단] mcp-tools.md §4.4 입력의 suspectedCause/nextAction은 schema.sql의 issues 테이블에
// 전용 컬럼이 없다(title/description/severity/resolution_note만 존재). decisions.js가
// alternatives/reversalCondition을 reason 텍스트에 흡수하는 것과 동일한 방식으로,
// suspectedCause는 description에 "[의심 원인]" 절로, nextAction은 resolve 시 resolution_note에
// "[다음 조치]" 절로 흡수한다 — 스키마 재설계 없이 입력 스펙을 충족시키는 최소 변경.
import { newId } from './ulid.js'
import { parseIdempotencyKey } from './idempotency.js'

const SEVERITIES = ['low', 'medium', 'high', 'critical']

function validationError(message) {
  const e = new Error(message)
  e.name = 'ValidationError'
  return e
}
function notFoundError(message) {
  const e = new Error(message)
  e.name = 'NotFoundError'
  return e
}

function buildDescription(summary, suspectedCause) {
  let text = summary || ''
  if (suspectedCause) text += (text ? '\n\n' : '') + `[의심 원인] ${suspectedCause}`
  return text
}

export async function recordIssue(db, { userId, projectId, issueId, status, title, summary, severity, suspectedCause, result, nextAction, idempotencyKey }) {
  if (!idempotencyKey) throw validationError('idempotencyKey is required')
  if (severity && !SEVERITIES.includes(severity)) throw validationError(`severity must be one of ${SEVERITIES.join(',')}`)
  if (!['opened', 'updated', 'resolved'].includes(status)) throw validationError('status must be opened|updated|resolved')

  if (status === 'opened') {
    if (issueId) throw validationError('issueId must not be provided when status=opened')
    if (!title || title.length < 1 || title.length > 200) throw validationError('title must be 1..200 chars')
    const description = buildDescription(summary, suspectedCause).slice(0, 2000)
    if (!description) throw validationError('summary is required to open an issue')

    const existing = await db.prepare('SELECT * FROM issues WHERE idempotency_key = ?').bind(idempotencyKey).first()
    if (existing) return { issueId: existing.id, status: existing.status }

    const { sessionId } = parseIdempotencyKey(idempotencyKey)
    const id = newId()
    const now = new Date().toISOString()
    try {
      await db.prepare(
        `INSERT INTO issues (id, project_id, user_id, title, description, severity, status, session_id, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
      ).bind(id, projectId, userId, title, description, severity || 'medium', sessionId, idempotencyKey, now).run()
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        const row = await db.prepare('SELECT * FROM issues WHERE idempotency_key = ?').bind(idempotencyKey).first()
        if (row) return { issueId: row.id, status: row.status }
      }
      throw e
    }
    return { issueId: id, status: 'open' }
  }

  // status === 'updated' | 'resolved' — 기존 이슈 갱신, 같은 PK 행 UPDATE
  if (!issueId) throw validationError('issueId is required to update or resolve an issue')
  // 오타·타인 이슈 접근 모두 NOT_FOUND로 위장(IDOR 방지, mcp-tools.md §4.4).
  const row = await db.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').bind(issueId, projectId).first()
  if (!row) throw notFoundError('issue not found')

  const now = new Date().toISOString()
  if (status === 'resolved') {
    const resolutionNote = [result, nextAction ? `[다음 조치] ${nextAction}` : null].filter(Boolean).join('\n\n').slice(0, 2000) || null
    await db.prepare(
      "UPDATE issues SET status='resolved', resolved_at=?, resolution_note=?, severity=COALESCE(?, severity) WHERE id = ?"
    ).bind(now, resolutionNote, severity || null, issueId).run()
    return { issueId, status: 'resolved', resolvedAt: now }
  }

  // status === 'updated'
  const newTitle = title || row.title
  const newDescription = summary !== undefined ? buildDescription(summary, suspectedCause).slice(0, 2000) : row.description
  await db.prepare(
    'UPDATE issues SET title = ?, description = ?, severity = COALESCE(?, severity) WHERE id = ?'
  ).bind(newTitle, newDescription, severity || null, issueId).run()
  return { issueId, status: row.status }
}

/** get_project_context용 — status='open'만, severity 높은 순(§4.1). */
export async function listOpenForContext(db, projectId, limit = 10) {
  const { results } = await db.prepare(
    `SELECT * FROM issues WHERE project_id = ? AND status = 'open'
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC
     LIMIT ?`
  ).bind(projectId, limit).all()
  return results
}

/** 커서 기반 목록 조회(next_cursor=id — api.md §5.4). status 기본 'open', 'all'이면 전체. */
export async function listIssues(db, projectId, { cursor, limit = 20, status = 'open', severity } = {}) {
  const params = [projectId]
  let sql = 'SELECT * FROM issues WHERE project_id = ?'
  if (status && status !== 'all') {
    sql += ' AND status = ?'
    params.push(status)
  }
  if (severity) {
    sql += ' AND severity = ?'
    params.push(severity)
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
