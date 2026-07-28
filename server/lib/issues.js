// issues(issue_record/issue_resolve) 공통 구현 — open 시 INSERT, resolve 시 같은 PK 행을 UPDATE
// (architecture.md §0-11, mcp-tools.md §4.4/§4.5). 2026-07-28 전면 개명으로 record_issue(opened/
// updated/resolved 3분기 단일 도구)가 issue_record(opened 전용)/issue_resolve(resolved 전용)
// 2개로 분리됐다 — updated 분기(열린 이슈 갱신)는 그대로 제거(§4.4 "issue_update는 만들지 않기로
// 함" 참고, 실사용 데이터 없이 미리 만들지 않는다는 원칙).
//
// [설계 판단] mcp-tools.md §4.4 입력의 suspectedCause는 schema.sql의 issues 테이블에 전용 컬럼이
// 없다(title/description/severity/resolution_note만 존재). decisions.js가 alternatives/
// reversalCondition을 reason 텍스트에 흡수하는 것과 동일한 방식으로, suspectedCause는
// description에 "[의심 원인]" 절로 흡수한다 — 스키마 재설계 없이 입력 스펙을 충족시키는 최소 변경.
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

/** issue_record(§4.4) — opened 전용. idempotency_key UNIQUE 위반(재전송) 시 기존 행을 그대로 반환. */
export async function recordIssue(db, { userId, projectId, title, summary, severity, suspectedCause, idempotencyKey }) {
  if (!idempotencyKey) throw validationError('idempotencyKey is required')
  if (severity && !SEVERITIES.includes(severity)) throw validationError(`severity must be one of ${SEVERITIES.join(',')}`)
  if (!title || title.length < 1 || title.length > 200) throw validationError('title must be 1..200 chars')
  const description = buildDescription(summary, suspectedCause).slice(0, 2000)
  if (!description) throw validationError('summary is required to open an issue')

  const existing = await db.prepare('SELECT * FROM issues WHERE idempotency_key = ?').bind(idempotencyKey).first()
  if (existing) return { issueId: existing.id, createdAt: existing.created_at }

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
      if (row) return { issueId: row.id, createdAt: row.created_at }
    }
    throw e
  }
  return { issueId: id, createdAt: now }
}

/** issue_resolve(§4.5) — resolved 전용, 같은 PK 행 UPDATE. idempotencyKey 없음(UPDATE 자체가
 *  자연히 멱등, §4.5). issueId가 없거나 본인 소유 project의 이슈가 아니면 NOT_FOUND로 위장
 *  (오타·타인 이슈 접근 모두 이 코드로, IDOR 방지). */
export async function resolveIssue(db, { projectId, issueId, result }) {
  if (!issueId) throw validationError('issueId is required')
  if (!result) throw validationError('result is required')
  const row = await db.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').bind(issueId, projectId).first()
  if (!row) throw notFoundError('issue not found')

  const now = new Date().toISOString()
  const resolutionNote = String(result).slice(0, 2000)
  await db.prepare(
    "UPDATE issues SET status='resolved', resolved_at=?, resolution_note=? WHERE id = ?"
  ).bind(now, resolutionNote, issueId).run()
  return { issueId, resolvedAt: now }
}

/** project_get_context용 — status='open'만, severity 높은 순(§4.1). */
export async function listOpenForContext(db, projectId, limit = 10) {
  const { results } = await db.prepare(
    `SELECT * FROM issues WHERE project_id = ? AND status = 'open'
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC
     LIMIT ?`
  ).bind(projectId, limit).all()
  return results
}

/** state.health 계산 전용(§4.1) — open 이슈의 severity별 개수. listOpenForContext의 limit 절단에
 *  기대지 않고 항상 전체 open 이슈의 severity 분포를 정확히 반영하기 위한 별도 집계 쿼리
 *  (idx_issues_project_severity 인덱스 활용). */
export async function getOpenSeverityCounts(db, projectId) {
  const { results } = await db.prepare(
    "SELECT severity, COUNT(*) AS cnt FROM issues WHERE project_id = ? AND status = 'open' GROUP BY severity"
  ).bind(projectId).all()
  const counts = { low: 0, medium: 0, high: 0, critical: 0 }
  for (const r of results) counts[r.severity] = r.cnt
  return counts
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
