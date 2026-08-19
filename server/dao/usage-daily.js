// usage_daily 테이블 DAO — POST /api/sessions(CAS 재집계 쓰기)와 GET /api/usage/me,
// GET /api/admin/usage/summary(읽기) 여러 진입점이 공유(DAO 분리 기준). schema.sql §3.12,
// architecture.md §0 결정17(낙관적 잠금 CAS)·결정25(PK를 (user_id, day_at)로 축소).

export async function findForUserDay(db, userId, dayAt) {
  return db.prepare('SELECT * FROM usage_daily WHERE user_id = ? AND day_at = ?').bind(userId, dayAt).first()
}

/** 최초 생성 전용 — 0값 placeholder 행을 만들어야 그 다음 CAS UPDATE가 걸 행이 생긴다.
 *  동시에 다른 요청이 먼저 만들었을 수 있으므로 ON CONFLICT DO NOTHING(§7.2 5-c). */
export async function insertInitialIfMissing(db, userId, dayAt, now) {
  await db.prepare(
    `INSERT INTO usage_daily (user_id, day_at, session_count, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, tool_calls, tool_errors, retries, updated_at)
     VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)
     ON CONFLICT(user_id, day_at) DO NOTHING`
  ).bind(userId, dayAt, now).run()
}

/** 낙관적 잠금(CAS) UPDATE — WHERE updated_at = prevUpdatedAt인 경우에만 반영된다(§7.2 5-b).
 *  changes=0이면 그 사이 다른 요청이 먼저 갱신했다는 뜻 — 호출부(lib/usage-daily.js)가 재시도. */
export async function casUpdate(db, userId, dayAt, agg, prevUpdatedAt, newUpdatedAt) {
  const res = await db.prepare(
    `UPDATE usage_daily SET
       session_count = ?, input_tokens = ?, output_tokens = ?,
       cache_read_tokens = ?, cache_write_tokens = ?,
       tool_calls = ?, tool_errors = ?, retries = ?, updated_at = ?
     WHERE user_id = ? AND day_at = ? AND updated_at = ?`
  ).bind(
    agg.session_count, agg.input_tokens, agg.output_tokens,
    agg.cache_read_tokens, agg.cache_write_tokens,
    agg.tool_calls, agg.tool_errors, agg.retries, newUpdatedAt,
    userId, dayAt, prevUpdatedAt
  ).run()
  return res.meta.changes > 0
}

/** GET /api/usage/me — 본인 행만(api.md §5.5). */
export async function findForUser(db, userId, { from, to } = {}) {
  const params = [userId]
  let sql = 'SELECT * FROM usage_daily WHERE user_id = ?'
  if (from) {
    sql += ' AND day_at >= ?'
    params.push(from)
  }
  if (to) {
    sql += ' AND day_at <= ?'
    params.push(to)
  }
  sql += ' ORDER BY day_at'
  const { results } = await db.prepare(sql).bind(...params).all()
  return results
}

/** GET /api/admin/usage/summary — 전사(전 사용자) 일별 추세(organizations 없음 → 조직 스코프 없이
 *  day_at으로만 GROUP, api.md §5.5/§5.6). */
export async function sumAllByDay(db, { from, to } = {}) {
  const params = []
  let sql = `SELECT day_at,
       SUM(session_count) as session_count,
       SUM(input_tokens) as input_tokens,
       SUM(output_tokens) as output_tokens,
       SUM(cache_read_tokens) as cache_read_tokens,
       SUM(cache_write_tokens) as cache_write_tokens,
       SUM(tool_calls) as tool_calls,
       SUM(tool_errors) as tool_errors,
       SUM(retries) as retries
     FROM usage_daily WHERE 1=1`
  if (from) {
    sql += ' AND day_at >= ?'
    params.push(from)
  }
  if (to) {
    sql += ' AND day_at <= ?'
    params.push(to)
  }
  sql += ' GROUP BY day_at ORDER BY day_at'
  const { results } = await db.prepare(sql).bind(...params).all()
  return results
}
