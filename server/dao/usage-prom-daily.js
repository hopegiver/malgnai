// usage_prom_daily / usage_prom_sync_days DAO — D1 접근 전용(설계 §3 모듈 경계 원칙: D1 접근은
// 이 파일에만 둔다). server/lib/usage-prom.js(하이브리드 읽기)와 server/lib/usage-rollup.js(Cron
// 적재)가 공유한다. 설계 정본: docs/design/usage-prometheus-realtime.md §17.5(읽기)·§18.5(쓰기).
//
// ⚠️ usage_daily(자체수집, server/dao/usage-daily.js)와는 완전히 별개 테이블이다. 이 파일은 그
// DAO를 import하지 않고, 그 DAO도 이 파일을 import하지 않는다 — 오염 차단을 규율이 아니라 구조로
// 강제한다(설계 §17.2b, §21 "관리자 라우트가 usageDailyDao를 import조차 하지 않는다").

/** 하이브리드 읽기(설계 §19.4)용 — [from, cacheTo] 구간을 한 번의 db.batch()로 4가지를 함께 읽는다
 *  (설계 §17.5 "①~④는 Promise.all이 아니라 db.batch() 한 번으로" — 같은 시점의 스냅샷을 보장).
 *
 *  validRows: day_at×user_email 그레인의 원본 행(설계 §17.5 SQL①②처럼 SUM+GROUP BY로 기간 집계하지
 *  않고, day_at·user_email당 이미 1행뿐인 PK 특성을 살려 원본을 그대로 반환한다) — 이래야
 *  usage-prom.js의 getUsageOverviewHybrid가 라이브 병합과 동일한 Map<email,Map<day,values>> 구조로
 *  꽂아 넣을 수 있고(§19.4), agg_mode/norm_version이 현재값과 다른 날(재적재 대상)을 조인 조건으로
 *  자연스럽게 배제할 수 있다(SUM 집계로는 이 배제를 사후에 다시 걸러야 해 이중 로직이 된다).
 *  coverageInRange: 설계 §17.5 SQL③ 그대로(구간 내 커버리지 마커 — gap_days/segments.cached 판정용).
 *  allCoverage: meta.rollup.cached_through(§17.6) 계산에는 요청 구간 밖의 과거까지 봐야 하므로 전체
 *  커버리지를 day_at 오름차순으로 받는다(설계 §17.4 — 연 3,650행 규모라 무시 가능한 비용).
 *  dataStart/lastSyncAt: 설계 §17.5 SQL④ 그대로.
 *
 *  emailFilter(승인결정1, GET /api/usage/me 전환 신규) — 소문자 정규화된 email 또는 null. null이면
 *  기존 admin 라우트(/summary·/users)와 동일하게 전 사용자 무필터. 값이 있으면 SQL WHERE 절에서
 *  직접 걸러(파라미터 바인딩, 인젝션 불가) 다른 사용자 행이 Worker 메모리로 올라오지도 않는다 —
 *  라우트 코드가 실수로 필터를 빠뜨려도 이 DAO 한 겹이 IDOR을 구조적으로 막는다(defense in depth,
 *  usage_prom_daily.user_email은 §17.3에 의해 항상 소문자로 저장되므로 대소문자 정규화 없이 등호
 *  비교만으로 충분하다). */
export async function readHybridSnapshot(db, from, cacheTo, aggMode, normVersion, emailFilter = null) {
  const stmts = [
    db.prepare(
      `SELECT d.day_at, d.user_email, d.employee_name, d.session_count, d.input_tokens,
              d.output_tokens, d.cache_read_tokens, d.cache_write_tokens, d.cost_usd
         FROM usage_prom_daily d
         JOIN usage_prom_sync_days s ON s.day_at = d.day_at
        WHERE d.day_at BETWEEN ?1 AND ?2 AND s.agg_mode = ?3 AND s.norm_version = ?4
          AND (?5 IS NULL OR d.user_email = ?5)
        ORDER BY d.day_at`
    ).bind(from, cacheTo, aggMode, normVersion, emailFilter),
    db.prepare(
      `SELECT day_at, agg_mode, norm_version, user_rows, unknown_types_json, fetched_at
         FROM usage_prom_sync_days WHERE day_at BETWEEN ?1 AND ?2 ORDER BY day_at`
    ).bind(from, cacheTo),
    db.prepare('SELECT day_at, agg_mode, norm_version FROM usage_prom_sync_days ORDER BY day_at'),
    db.prepare('SELECT MIN(day_at) AS data_start, MAX(fetched_at) AS last_sync_at FROM usage_prom_sync_days')
  ]
  const [rowsRes, coverageRes, allCoverageRes, overallRes] = await db.batch(stmts)
  const overall = (overallRes.results && overallRes.results[0]) || {}
  return {
    validRows: rowsRes.results,
    coverageInRange: coverageRes.results,
    allCoverage: allCoverageRes.results,
    dataStart: overall.data_start ?? null,
    lastSyncAt: overall.last_sync_at ?? null
  }
}

/** GET /api/admin/usage/users/:id(전 구간 라이브)용 — data_start/last_sync_at만 가볍게 얻는다
 *  (설계 §4.5). 다른 D1 읽기와 동시에 필요하지 않아 단일 쿼리로 충분하다(batch 불필요). */
export async function readOverallCoverage(db) {
  const row = await db.prepare(
    'SELECT MIN(day_at) AS data_start, MAX(fetched_at) AS last_sync_at FROM usage_prom_sync_days'
  ).first()
  return { dataStart: row?.data_start ?? null, lastSyncAt: row?.last_sync_at ?? null }
}

/** Cron 결손 탐지(설계 §18.4 ① 대상 날짜 산출)용 — [from,to] 구간의 커버리지 마커를 유효/무효 모두
 *  포함해 반환한다. 유효성 판정(agg_mode/norm_version 일치 여부)은 호출부(usage-rollup.js)가 현재
 *  상수와 비교해 직접 한다. */
export async function selectCoverageRange(db, from, to) {
  const { results } = await db.prepare(
    'SELECT day_at, agg_mode, norm_version, user_rows FROM usage_prom_sync_days WHERE day_at BETWEEN ?1 AND ?2 ORDER BY day_at'
  ).bind(from, to).all()
  return results
}

/** M-3 수정(리뷰 2026-09-03) — "상류가 실제로 사용자 활동을 관측한 가장 오래된 날"(user_rows>0인
 *  마커 중 MIN day_at). usage-rollup.js가 이 날짜를 하한선으로 삼아 "그보다 같거나 최근인 날의
 *  0행 결과 = 확인된 0"과 "그보다 오래된 날의 0행 결과 = 상류 보관기간 이전이라 모르는 것"을
 *  구분한다(§18.4/§18.5 "0을 위조된 사실로 만들지 않는다"). 상류 보관기간은 매일 조금씩 뒤로
 *  밀리므로(sliding retention) 이 값은 하드코딩 상수가 아니라 매 회차 이 쿼리로 다시 구한다 —
 *  단, 상류에 별도 질의를 던지는 게 아니라 우리가 이미 커밋해 둔 결과만 보므로 비용은 D1 1행뿐이다
 *  (설계가 이미 폐기한 "비싼 상류 프로브 방식", §4.5 C5와 혼동하지 말 것). */
export async function selectEarliestActivityDay(db, aggMode, normVersion) {
  const row = await db.prepare(
    'SELECT MIN(day_at) AS day_at FROM usage_prom_sync_days WHERE user_rows > 0 AND agg_mode = ?1 AND norm_version = ?2'
  ).bind(aggMode, normVersion).first()
  return row?.day_at ?? null
}

/** 설계 §18.5 — 날짜 1개 원자 커밋(DELETE 전부 + INSERT N개 + 마커 UPSERT, db.batch() 단일 암묵
 *  트랜잭션). 절대값 저장(증분 아님) — 같은 날짜를 몇 번 다시 돌려도 결과가 같다(멱등). rows가
 *  비어 있어도(그날 사용량 0) 마커는 반드시 쓴다 — user_rows=0이 "그날 아무도 안 썼다"는 확정
 *  사실이 되어, 다음 회차가 이 날을 다시 결손으로 취급하지 않는다(설계 §17.3).
 *
 *  ⚠️ 마커(usage_prom_sync_days INSERT)는 이 배열의 반드시 마지막 statement여야 한다 — 부분 실패
 *  시(batch 전체가 원자적으로 롤백되므로 실제로는 "전부 아니면 전무"이지만, 이 순서 자체가 설계
 *  의도를 코드로 남겨 향후 이 함수를 청크 단위로 쪼갤 때도 규칙이 깨지지 않게 한다) 마커 없음 →
 *  다음 회차의 결손 탐지가 자동으로 재적재한다.
 *
 *  한 날짜의 statement 수가 커지면(설계 §18.5 "200개 넘으면 그 날짜만 여러 batch로 쪼개되 마커는
 *  반드시 마지막 batch에") 이 함수는 그 분할을 하지 않는다 — 현재 규모(사용자 10명대, 날짜당
 *  1(DELETE) + N(INSERT, N≈10) + 1(마커) ≈ 12 statement)에서는 해당 없음(설계 §18.5). 사용자 수가
 *  늘어 그 상한에 근접하면 이 함수를 청크 분할하도록 개정할 것. */
export async function commitDay(db, dayAt, rows, marker) {
  const stmts = [db.prepare('DELETE FROM usage_prom_daily WHERE day_at = ?1').bind(dayAt)]
  for (const r of rows) {
    stmts.push(
      db.prepare(
        `INSERT INTO usage_prom_daily
           (day_at, user_email, employee_name, session_count, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(
        dayAt, r.user_email, r.employee_name || null, r.session_count, r.input_tokens, r.output_tokens,
        r.cache_read_tokens, r.cache_write_tokens, r.cost_usd
      )
    )
  }
  stmts.push(
    db.prepare(
      `INSERT INTO usage_prom_sync_days (day_at, agg_mode, norm_version, user_rows, unknown_types_json, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(day_at) DO UPDATE SET
         agg_mode = excluded.agg_mode, norm_version = excluded.norm_version,
         user_rows = excluded.user_rows, unknown_types_json = excluded.unknown_types_json,
         fetched_at = excluded.fetched_at`
    ).bind(dayAt, marker.aggMode, marker.normVersion, rows.length, marker.unknownTypesJson, marker.fetchedAt)
  )
  await db.batch(stmts)
}
