// sessions 테이블 DAO — 여러 진입점(POST /api/sessions 인입, GET /api/usage/sessions,
// GET /api/usage/projects/:id 재집계)이 공유하므로 DAO로 분리(backend-api-implementation-patterns
// 스킬의 DAO 판단 기준). architecture.md §7.2/§3.10, schema.sql §3.10(2026-08-19 슬리밍 반영).

/** id = sha256(device_id + ':' + claude_session_id)로 결정적 upsert(§7.2 멱등성).
 *  user_id/created_at/claude_session_id/device_id는 최초 생성 시 값으로 고정하고 갱신하지 않는다
 *  (device_id는 세션 소유권 판단에 쓰이므로 재전송 시 값이 흔들리면 안 됨) — 그 외 필드는 항상
 *  "누적 최종값"으로 덮어쓴다(델타 아님, schema.sql §3.10 주석). */
export async function upsertFinal(db, s) {
  await db.prepare(
    `INSERT INTO sessions (
       id, project_id, user_id, device_id, plugin_version, claude_session_id,
       started_at, ended_at, duration_seconds, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       tool_calls, tool_errors, retries, files_read, files_changed, commits,
       summary, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       plugin_version = excluded.plugin_version,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       duration_seconds = excluded.duration_seconds,
       model = excluded.model,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cache_read_tokens = excluded.cache_read_tokens,
       cache_write_tokens = excluded.cache_write_tokens,
       tool_calls = excluded.tool_calls,
       tool_errors = excluded.tool_errors,
       retries = excluded.retries,
       files_read = excluded.files_read,
       files_changed = excluded.files_changed,
       commits = excluded.commits,
       summary = excluded.summary`
  ).bind(
    s.id, s.projectId, s.userId, s.deviceId, s.pluginVersion, s.claudeSessionId,
    s.startedAt, s.endedAt, s.durationSeconds, s.model,
    s.inputTokens, s.outputTokens, s.cacheReadTokens, s.cacheWriteTokens,
    s.toolCalls, s.toolErrors, s.retries, s.filesRead, s.filesChanged, s.commits,
    s.summary, new Date().toISOString()
  ).run()
}

export async function findById(db, id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first()
}

/** usage_daily CAS 재집계용 — 특정 (user_id, day_at) 버킷을 sessions에서 재-SUM(architecture.md §7.2 5-a). */
export async function sumForUserDay(db, userId, dayAt) {
  return db.prepare(
    `SELECT COUNT(*) as session_count,
       COALESCE(SUM(input_tokens),0) as input_tokens,
       COALESCE(SUM(output_tokens),0) as output_tokens,
       COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
       COALESCE(SUM(cache_write_tokens),0) as cache_write_tokens,
       COALESCE(SUM(tool_calls),0) as tool_calls,
       COALESCE(SUM(tool_errors),0) as tool_errors,
       COALESCE(SUM(retries),0) as retries
     FROM sessions WHERE user_id = ? AND substr(started_at,1,10) = ?`
  ).bind(userId, dayAt).first()
}

/** GET /api/usage/projects/:id — usage_daily에 project_id가 없어(§0 결정25) sessions를 직접
 *  day_at별로 재집계한다(api.md §5.5). */
export async function sumByProjectDay(db, projectId, userId, { from, to } = {}) {
  const params = [projectId, userId]
  let sql = `SELECT substr(started_at,1,10) as day_at,
       COUNT(*) as session_count,
       COALESCE(SUM(input_tokens),0) as input_tokens,
       COALESCE(SUM(output_tokens),0) as output_tokens,
       COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
       COALESCE(SUM(cache_write_tokens),0) as cache_write_tokens,
       COALESCE(SUM(tool_calls),0) as tool_calls,
       COALESCE(SUM(tool_errors),0) as tool_errors,
       COALESCE(SUM(retries),0) as retries
     FROM sessions WHERE project_id = ? AND user_id = ? AND started_at IS NOT NULL`
  if (from) {
    sql += ' AND substr(started_at,1,10) >= ?'
    params.push(from)
  }
  if (to) {
    sql += ' AND substr(started_at,1,10) <= ?'
    params.push(to)
  }
  sql += ' GROUP BY day_at ORDER BY day_at'
  const { results } = await db.prepare(sql).bind(...params).all()
  return results
}

function encodeCursor(startedAt, id) {
  const json = JSON.stringify([startedAt, id])
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCursor(cursor) {
  try {
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const [startedAt, id] = JSON.parse(atob(padded))
    if (typeof startedAt !== 'string' || typeof id !== 'string') return null
    return { startedAt, id }
  } catch {
    return null
  }
}

/** GET /api/usage/sessions — 커서 페이지네이션(api.md §5.5). sessions.id는 sha256 해시라 ULID처럼
 *  시간정렬이 아니므로(works.js와 달리) (started_at DESC, id DESC) 복합 커서를 쓴다. */
export async function listForUser(db, userId, { cursor, limit = 20 } = {}) {
  const params = [userId]
  let sql = 'SELECT * FROM sessions WHERE user_id = ?'
  const decoded = cursor ? decodeCursor(cursor) : null
  if (decoded) {
    sql += ' AND (started_at < ? OR (started_at = ? AND id < ?))'
    params.push(decoded.startedAt, decoded.startedAt, decoded.id)
  }
  sql += ' ORDER BY started_at DESC, id DESC LIMIT ?'
  params.push(limit + 1)
  const { results } = await db.prepare(sql).bind(...params).all()
  const hasMore = results.length > limit
  const page = hasMore ? results.slice(0, limit) : results
  const last = page[page.length - 1]
  return { data: page, next_cursor: hasMore && last ? encodeCursor(last.started_at, last.id) : null }
}
