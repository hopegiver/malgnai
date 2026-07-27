// search_project_history / GET .../history/search 공통 구현(mcp-tools.md §4.6, api.md §5.4).
// 단일 타입 필터는 그 테이블의 FTS5(trigram) 가상테이블 조회 1개, 복수/미지정은 3개 쿼리를
// Promise.all로 병렬 실행 후 애플리케이션에서 병합 정렬(architecture.md §0 결정11).
const TYPES = ['decision', 'issue', 'work']

function validationError(message) {
  const e = new Error(message)
  e.name = 'ValidationError'
  return e
}

/** FTS5 MATCH 인자를 구문(phrase)으로 감싸 특수문자(연산자 오인)를 피한다. */
function escapeFtsQuery(query) {
  return `"${String(query).replace(/"/g, '""')}"`
}

async function searchDecisions(db, projectId, ftsQuery, importanceMin, since, limit) {
  let sql = `
    SELECT d.id, d.title, d.summary AS snippet, d.created_at
    FROM decisions_fts f JOIN decisions d ON d.id = f.id
    WHERE decisions_fts MATCH ? AND d.project_id = ? AND d.importance >= ?`
  const params = [ftsQuery, projectId, importanceMin || 1]
  if (since) {
    sql += ' AND d.created_at >= ?'
    params.push(since)
  }
  sql += ' ORDER BY d.created_at DESC LIMIT ?'
  params.push(limit)
  const { results } = await db.prepare(sql).bind(...params).all()
  return results.map((r) => ({ type: 'decision', id: r.id, title: r.title, snippet: r.snippet, created_at: r.created_at }))
}

async function searchIssues(db, projectId, ftsQuery, since, limit) {
  let sql = `
    SELECT i.id, i.title, i.description AS snippet, i.created_at
    FROM issues_fts f JOIN issues i ON i.id = f.id
    WHERE issues_fts MATCH ? AND i.project_id = ?`
  const params = [ftsQuery, projectId]
  if (since) {
    sql += ' AND i.created_at >= ?'
    params.push(since)
  }
  sql += ' ORDER BY i.created_at DESC LIMIT ?'
  params.push(limit)
  const { results } = await db.prepare(sql).bind(...params).all()
  return results.map((r) => ({ type: 'issue', id: r.id, title: r.title, snippet: r.snippet, created_at: r.created_at }))
}

async function searchWorks(db, projectId, ftsQuery, since, limit) {
  let sql = `
    SELECT w.id, w.title, w.detail AS snippet, w.created_at
    FROM works_fts f JOIN works w ON w.id = f.id
    WHERE works_fts MATCH ? AND w.project_id = ?`
  const params = [ftsQuery, projectId]
  if (since) {
    sql += ' AND w.created_at >= ?'
    params.push(since)
  }
  sql += ' ORDER BY w.created_at DESC LIMIT ?'
  params.push(limit)
  const { results } = await db.prepare(sql).bind(...params).all()
  return results.map((r) => ({ type: 'work', id: r.id, title: r.title, snippet: r.snippet, created_at: r.created_at }))
}

export async function searchProjectHistory(db, projectId, { query, types, importanceMin = 1, since, limit = 10 } = {}) {
  if (!query || query.length < 1 || query.length > 200) throw validationError('query must be 1..200 chars')
  if (limit < 1 || limit > 30) throw validationError('limit must be 1..30')

  const wantedTypes = Array.isArray(types) && types.length ? types.filter((t) => TYPES.includes(t)) : TYPES
  const ftsQuery = escapeFtsQuery(query)

  const tasks = []
  if (wantedTypes.includes('decision')) tasks.push(searchDecisions(db, projectId, ftsQuery, importanceMin, since, limit))
  if (wantedTypes.includes('issue')) tasks.push(searchIssues(db, projectId, ftsQuery, since, limit))
  if (wantedTypes.includes('work')) tasks.push(searchWorks(db, projectId, ftsQuery, since, limit))

  const settled = await Promise.all(tasks)
  const merged = settled.flat().sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  return { results: merged.slice(0, limit) }
}
