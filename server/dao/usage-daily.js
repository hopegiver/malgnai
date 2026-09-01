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
       cache_read_tokens, cache_write_tokens, tool_calls, tool_errors, retries,
       turns, api_calls, updated_at)
     VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
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
       tool_calls = ?, tool_errors = ?, retries = ?,
       turns = ?, api_calls = ?, updated_at = ?
     WHERE user_id = ? AND day_at = ? AND updated_at = ?`
  ).bind(
    agg.session_count, agg.input_tokens, agg.output_tokens,
    agg.cache_read_tokens, agg.cache_write_tokens,
    agg.tool_calls, agg.tool_errors, agg.retries,
    agg.turns, agg.api_calls, newUpdatedAt,
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

/** GET /api/admin/usage/users의 sort 화이트리스트 → 고정 ORDER BY 조각 매핑(api.md §5.8.4 함정4 —
 *  ORDER BY 자리는 `?` 바인딩이 안 되므로 사용자 입력 문자열을 절대 SQL에 직접 넣지 않는다).
 *  호출부(server/api/usage.js)가 이 맵의 key로만 sort 쿼리값을 검증하고, value(고정 문자열)만
 *  SQL에 꽂는다. name은 COALESCE(u.name, u.email) COLLATE NOCASE로 정렬(§5.8.4 함정5, 널 이름이
 *  맨 앞에 몰리는 것 방지). */
export const USER_SUMMARY_SORT_COLUMNS = {
  tokens: 'total_tokens',
  sessions: 'session_count',
  turns: 'turns',
  api_calls: 'api_calls',
  tool_errors: 'tool_errors',
  last_active: 'last_active_day',
  name: 'sort_name COLLATE NOCASE'
}

/** GET /api/admin/usage/users — 사용자별 기간 합계(api.md §5.8.1). users를 왼쪽에 두고
 *  usage_daily를 LEFT JOIN해 기간 중 사용량이 0인 직원도 0행으로 포함한다. 날짜 범위 조건은
 *  반드시 LEFT JOIN의 ON 절에 둔다 — WHERE에 두면 INNER JOIN으로 퇴화해 사용량 0인 사용자가
 *  조용히 사라진다(§5.8.4 함정1). 집계 컬럼은 COALESCE(SUM(...),0)(함정2), active_days는
 *  COUNT(d.day_at)(널 제외, 함정3). sortColumn/orderDirection은 호출부가
 *  USER_SUMMARY_SORT_COLUMNS/화이트리스트로 검증을 마친 고정 문자열만 넘겨야 한다(함정4).
 *  truncated 판정을 위해 limit보다 1개 더(fetchLimit = limit+1) 받아 호출부가 자른다(함정6, 기존
 *  server/dao/sessions.js listForUser 관례와 동일). */
export async function listUserSummaries(db, { from, to, sortColumn, orderDirection, fetchLimit }) {
  const sql = `SELECT u.id as user_id, u.name, u.email, u.role, u.status,
      COALESCE(u.name, u.email) as sort_name,
      COUNT(d.day_at) as active_days,
      COALESCE(SUM(d.session_count),0) as session_count,
      COALESCE(SUM(d.input_tokens),0) as input_tokens,
      COALESCE(SUM(d.output_tokens),0) as output_tokens,
      COALESCE(SUM(d.cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(d.cache_write_tokens),0) as cache_write_tokens,
      (COALESCE(SUM(d.input_tokens),0) + COALESCE(SUM(d.output_tokens),0)
        + COALESCE(SUM(d.cache_read_tokens),0) + COALESCE(SUM(d.cache_write_tokens),0)) as total_tokens,
      COALESCE(SUM(d.tool_calls),0) as tool_calls,
      COALESCE(SUM(d.tool_errors),0) as tool_errors,
      COALESCE(SUM(d.retries),0) as retries,
      COALESCE(SUM(d.turns),0) as turns,
      COALESCE(SUM(d.api_calls),0) as api_calls,
      MAX(d.day_at) as last_active_day
    FROM users u
    LEFT JOIN usage_daily d ON d.user_id = u.id AND d.day_at >= ? AND d.day_at <= ?
    GROUP BY u.id
    ORDER BY ${sortColumn} ${orderDirection}, u.id ASC
    LIMIT ?`
  const { results } = await db.prepare(sql).bind(from, to, fetchLimit).all()
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
       SUM(retries) as retries,
       SUM(turns) as turns,
       SUM(api_calls) as api_calls
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
