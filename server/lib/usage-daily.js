// usage_daily CAS 재집계 — server/api/sessions.js가 sessions upsert 직후 호출한다
// (architecture.md §7.2 5단계, §0 결정17). 무조건 REPLACE 대신 낙관적 잠금으로 손실 업데이트를
// 방지하되, 재시도가 모두 실패해도 이 값은 참고용 추세 지표일 뿐이라(과금 근거 아님) sessions
// 반영 자체를 실패로 되돌리지 않는다 — 실패 시 경고 로그만 남기고 계속 진행한다.
import * as sessionsDao from '../dao/sessions.js'
import * as usageDailyDao from '../dao/usage-daily.js'

const MAX_RETRIES = 3

/** (user_id, day_at) 버킷을 sessions에서 재-SUM해 usage_daily에 CAS로 반영한다.
 *  성공하면 true, 재시도를 모두 소진해도 반영 못하면 false(호출부는 이 실패를 무시해도 된다). */
export async function recomputeUsageDaily(db, userId, dayAt) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const existing = await usageDailyDao.findForUserDay(db, userId, dayAt)
    if (!existing) {
      // 최초 생성: 0값 placeholder를 만든 뒤(동시 요청과 충돌하면 DO NOTHING) 다음 루프에서
      // 그 행을 대상으로 CAS UPDATE를 건다(§7.2 5-c).
      await usageDailyDao.insertInitialIfMissing(db, userId, dayAt, new Date().toISOString())
      continue
    }
    const agg = await sessionsDao.sumForUserDay(db, userId, dayAt)
    const newUpdatedAt = new Date().toISOString()
    const changed = await usageDailyDao.casUpdate(db, userId, dayAt, agg, existing.updated_at, newUpdatedAt)
    if (changed) return true
    // changes===0: 그 사이 다른 요청이 먼저 더 최신값으로 갱신했다는 뜻(§7.2 5-d) — 재시도.
  }
  console.error(`[usage-daily] CAS recompute failed after ${MAX_RETRIES} retries (user_id=${userId}, day_at=${dayAt})`)
  return false
}
