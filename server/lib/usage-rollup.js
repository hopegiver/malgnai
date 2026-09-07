// Cron 적재 오케스트레이션 — 결손 탐지·청크 분할·시간 예산 루프(설계 §18). 부작용은 D1 write
// 하나뿐이고 server/index.js의 scheduled 핸들러(Cron)와 관리자 수동 트리거(§18.7, 있다면)가 동일한
// runUsageRollup()을 그대로 호출한다 — 호출자가 다른 것은 budgetMs뿐, 그 외 부작용은 완전히 동일하다
// (설계 §3 "호출자마다 부작용이 달라지는 지점은 이 설계에 없다").
//
// ⚠️ 이 파일은 dayGridWindow 등 시간창 계산을 새로 만들지 않는다 — server/lib/usage-prom.js의
// fetchCompletedDayGrid(내부적으로 dayGridWindow·표현식 빌더를 라이브 경로와 공유)를 그대로 호출해
// 이음매 양쪽이 항상 같은 계산을 하도록 보장한다(설계 §19.3-4 비협상 요구).
import { AGG_MODE, NORM_VERSION, fetchCompletedDayGrid } from './usage-prom.js'
import { UpstreamError } from './prom-client.js'
import * as usagePromDailyDao from '../dao/usage-prom-daily.js'
// m-2 수정(리뷰 2026-09-03) — todayUTCString/addDaysUTC를 이 파일에서 다시 구현하지 않고
// server/lib/utc-day.js(정본)를 그대로 쓴다. 이전에는 이 파일이 자체 복제본을 갖고 있었는데,
// 하필 이 복제본이 W1 불변식(Cron이 오늘을 롤업 대상에서 빼는 경계)을 판정하는 데 쓰였다.
import { todayUTCString, addDaysUTC } from './utc-day.js'

// 적재 정책 상수 단일 정본(설계 §18.4 표) — 값을 바꿀 때는 이 파일만 고치면 된다.
export const ROLLUP_HORIZON_DAYS = 40 // 상류 실데이터 ~37일 + 여유. 그보다 과거는 결손 탐지 대상에서 뺀다.
export const ROLLUP_TRAILING_RESCAN_DAYS = 3 // 최근 3일은 매번 덮어쓴다(지연 도착·경계 스미어 흡수, R11).
export const ROLLUP_CHUNK_DAYS = 7 // 실측 query_range 7일 step=1d ≈5.0초(R9), 상류 30초 벽에서 충분히 멀다.
export const ROLLUP_CRON_BUDGET_MS = 8 * 60 * 1000 // 플랫폼 상한 15분의 절반(나머지는 카탈로그 동기화 몫+여유).

// ⚠️ C-1 수정(리뷰 2026-09-03): 이 파일의 청크 루프는 매 반복에서
// `deadline - now < 예약시간(reserve)`이면 "이 청크를 끝까지 돌 여유가 없다"고 보고 즉시 멈춘다.
// Cron(budgetMs=ROLLUP_CRON_BUDGET_MS=8분)과 관리자 수동 트리거(POST /api/admin/usage/sync)는
// 예산 규모가 100배 가까이 다르므로 "여유가 있는가"의 기준(reserve)도 각자 따로 가져야 한다 —
// 원래 설계 문서(rev.2)가 둘 다 CHUNK_RESERVE_MS(35000) 하나를 같이 쓰라고 규정한 것 자체가
// 내부 모순이었다(요청 예산 8000 < reserve 35000 → 첫 반복부터 무조건 즉시 종료, 100% 0건 적재).
// runUsageRollup()은 이제 reserveMs를 별도 인자로 받고, 두 호출자가 서로 다른 reserve 상수를
// 넘긴다(부작용은 여전히 D1 write 하나로 동일 — 예산·reserve 두 숫자만 호출자마다 다르다).
export const CHUNK_RESERVE_MS = 35000 // Cron 전용 — "이 청크를 끝까지 돌 여유"(§18.4). 8분 예산 기준.
export const ROLLUP_REQUEST_BUDGET_MS = 30000 // 관리자 수동 트리거 전용. cron 프로필 질의 타임아웃
  // (PROM_CRON_QUERY_TIMEOUT_MS=25000ms, fetchCompletedDayGrid가 항상 이 프로필을 씀)로 청크 1개를
  // 최소 1회(타임아웃 재시도 없이) 끝까지 돌 수 있는 여유(25000 + 처리·D1 커밋 오버헤드). 이 라우트
  // (POST /sync)는 withRouteBudget(12000ms, prom-client.js)으로 감싸지 않으므로 12초 제약과 무관하다.
export const REQUEST_CHUNK_RESERVE_MS = 26000 // 관리자 수동 트리거 전용 reserve. cron 프로필 단일
  // 질의 타임아웃(25000ms) + 소여유(1000ms). CHUNK_RESERVE_MS(35000)는 8분 예산의 Cron에서만 의미
  // 있는 크기이고 3만ms대 요청 예산에는 항상 예산을 넘어 청크가 하나도 못 도는 산술 모순이었다(C-1).
  // 재시도(최대 1회, +25000ms)까지 완주할 여유는 의도적으로 보장하지 않는다 — 요청 경로에서 그만큼
  // 기다리게 하는 것은 M-1이 피하려는 것과 같은 종류의 사용자 대기이므로, 재시도가 필요한 정도로
  // 느린 상황은 다음 회차(다시 버튼을 누르거나 다음 Cron)에 맡긴다.

/** 설계 §18.5 결손 판정 — 마커가 없거나 agg_mode/norm_version이 현재 상수와 다르면 재적재 대상
 *  ("그 날의 값은 지금 규칙으로 만든 것이 아니다"). */
function isValidMarker(row) {
  return !!row && row.agg_mode === AGG_MODE && row.norm_version === NORM_VERSION
}

/** 설계 §18.4 ① 대상 날짜 산출 — trailing(최근 ROLLUP_TRAILING_RESCAN_DAYS일, 무조건 재적재) ⊎
 *  missing(그 이전 ~ ROLLUP_HORIZON_DAYS일 전까지, 결손인 날만). 반환은 최신→과거 순, 중복 없음. */
export async function computeTargetDays(db) {
  const today = todayUTCString()
  const yesterday = addDaysUTC(today, -1)
  const horizonStart = addDaysUTC(today, -ROLLUP_HORIZON_DAYS)
  const trailingStart = addDaysUTC(today, -ROLLUP_TRAILING_RESCAN_DAYS)

  const coverage = await usagePromDailyDao.selectCoverageRange(db, horizonStart, yesterday)
  const byDay = new Map(coverage.map((r) => [r.day_at, r]))

  const targets = []
  const seen = new Set()
  for (let d = yesterday; d >= trailingStart; d = addDaysUTC(d, -1)) {
    targets.push(d)
    seen.add(d)
  }
  for (let d = addDaysUTC(trailingStart, -1); d >= horizonStart; d = addDaysUTC(d, -1)) {
    if (seen.has(d)) continue
    if (!isValidMarker(byDay.get(d))) {
      targets.push(d)
      seen.add(d)
    }
  }
  return targets
}

/** ② 연속 구간으로 묶고 ROLLUP_CHUNK_DAYS 이하로 분할(설계 §18.4). 청크는 최신 날짜가 걸린 것부터
 *  처리하도록 정렬 — 가장 최근 결손을 우선 치유한다. */
function groupIntoChunks(targetDays) {
  const asc = [...targetDays].sort()
  const chunks = []
  let cur = []
  for (const d of asc) {
    if (cur.length && (cur.length >= ROLLUP_CHUNK_DAYS || addDaysUTC(cur[cur.length - 1], 1) !== d)) {
      chunks.push(cur)
      cur = []
    }
    cur.push(d)
  }
  if (cur.length) chunks.push(cur)
  chunks.sort((a, b) => (a[a.length - 1] < b[b.length - 1] ? 1 : -1))
  return chunks
}

function rowsFromByUser(byUser, dayAt) {
  const rows = []
  for (const entry of byUser.values()) {
    const day = entry.days.get(dayAt)
    if (!day) continue
    rows.push({
      user_email: (entry.displayEmail || '').toLowerCase(), // §17.3 "소문자 정규화 저장"
      employee_name: entry.employeeName,
      session_count: day.session_count,
      input_tokens: day.input_tokens,
      output_tokens: day.output_tokens,
      cache_read_tokens: day.cache_read_tokens,
      cache_write_tokens: day.cache_write_tokens,
      cost_usd: day.cost_usd
    })
  }
  return rows
}

/** 설계 §18.4 시간 예산 루프 본체 — Cron(server/index.js scheduled)과 관리자 수동 트리거가 공유.
 *  설정 누락 시 상류를 부르지 않고 즉시 no-op(§11 "Cron도 조용히 no-op 후 로그만"). 청크 조회 실패는
 *  그 청크만 건너뛰고 다음 청크로 진행(§18.6) — 실패한 날짜는 마커가 없으므로 다음 회차가 자동으로
 *  결손 탐지한다. */
export async function runUsageRollup(env, { budgetMs = ROLLUP_CRON_BUDGET_MS, reserveMs = CHUNK_RESERVE_MS } = {}) {
  const startedAt = Date.now()
  const deadline = startedAt + budgetMs

  if (!env.GRAFANA_BASE_URL || !env.GRAFANA_PROM_DATASOURCE_UID || !env.GRAFANA_API_TOKEN) {
    console.log('[usage-rollup] not configured — no-op')
    return { committed_days: [], remaining_gap_days: [], elapsed_ms: 0, budget_exhausted: false, skipped: 'not_configured' }
  }

  const targets = await computeTargetDays(env.DB)
  const chunks = groupIntoChunks(targets)
  const committedDays = []
  let budgetExhausted = false
  let attemptedChunks = 0
  let lastUpstreamErr = null

  // M-3 수정(리뷰 2026-09-03) — ROLLUP_HORIZON_DAYS(40)가 상류 실보관 기간(~37일, sliding)보다 길어,
  // 그 차이만큼의 날짜는 질의는 성공하지만 시계열이 아예 없어 0행으로 돌아온다. 이 0행이
  // "그날 아무도 안 썼다"(확인된 사실)인지 "상류가 그날을 아예 갖고 있지 않다"(모름)인지는 질의
  // 결과의 모양만으로 구분할 수 없다 — 그래서 우리가 이미 확보한 증거(더 최근 어느 날엔가 실제
  // 활동이 있었다는 사실)를 하한선으로 쓴다: 상류 보관기간은 오래된 쪽에서만 줄어들므로(sliding
  // window), 활동이 확인된 날 X가 있으면 X보다 같거나 최근인 모든 날은 반드시 보관기간 안에 있다.
  // 그래서 dayAt >= earliestActivityDay(X)인 0행만 "확인된 0"으로 커밋하고, 그보다 오래된 0행은
  // 마커를 아예 쓰지 않는다 — 다음 회차가 결손으로 계속 재탐지하고 meta.gap_days로 정직하게
  // 보고한다("모른다"를 "0"으로 확정 짓지 않는다). X는 이번 회차 안에서 최신 청크부터 처리하며
  // (groupIntoChunks가 최근 청크를 먼저 처리하도록 정렬) 계속 갱신된다 — 상류에 별도 프로브 질의를
  // 던지지 않고 이미 받은 결과만으로 판단한다(비싼 프로브는 §4.5에서 이미 폐기된 방식).
  let earliestActivityDay = await usagePromDailyDao.selectEarliestActivityDay(env.DB, AGG_MODE, NORM_VERSION)
  const unresolvedDays = []

  for (const chunk of chunks) {
    if (deadline - Date.now() < reserveMs) {
      budgetExhausted = true
      break
    }

    const chunkFrom = chunk[0]
    const chunkTo = chunk[chunk.length - 1]
    attemptedChunks += 1
    let byUser
    let unknownTypes
    try {
      const result = await fetchCompletedDayGrid(env, { from: chunkFrom, to: chunkTo })
      byUser = result.byUser
      unknownTypes = result.unknownTypes
    } catch (err) {
      console.error('[usage-rollup] chunk fetch failed (skipped — next run retries)', chunkFrom, chunkTo, err instanceof UpstreamError ? err.reason : err)
      if (err instanceof UpstreamError) lastUpstreamErr = err
      continue
    }

    // 이 청크 안에서 실제 활동이 관측된 날이 있으면 하한선을 그만큼 당긴다(같은 청크 안의 더
    // 오래된 0행 날짜에도 즉시 적용되도록 커밋 전에 먼저 갱신한다).
    for (const dayAt of chunk) {
      if (rowsFromByUser(byUser, dayAt).length === 0) continue
      if (earliestActivityDay === null || dayAt < earliestActivityDay) earliestActivityDay = dayAt
    }

    const unknownTypesJson = unknownTypes && unknownTypes.size ? JSON.stringify([...unknownTypes]) : null
    for (const dayAt of chunk) {
      const rows = rowsFromByUser(byUser, dayAt)
      if (rows.length === 0 && (earliestActivityDay === null || dayAt < earliestActivityDay)) {
        // 확인된 0이라고 말할 근거가 아직 없다 — 마커를 쓰지 않고 건너뛴다(§18.5 "모르면 쓰지 않는다").
        unresolvedDays.push(dayAt)
        console.log('[usage-rollup] day left unresolved (no confirmed upstream activity at/after this day yet — not committed as zero)', dayAt)
        continue
      }
      try {
        await usagePromDailyDao.commitDay(env.DB, dayAt, rows, {
          aggMode: AGG_MODE,
          normVersion: NORM_VERSION,
          unknownTypesJson,
          fetchedAt: new Date().toISOString()
        })
        committedDays.push(dayAt)
      } catch (err) {
        console.error('[usage-rollup] D1 commit failed for day (skipped — next run retries)', dayAt, err)
      }
    }
  }

  // 청크를 하나라도 시도했는데 전부 실패해 아무것도 커밋 못 했으면 진짜 상류 전면 장애다 — 그대로
  // 던진다. Cron 호출부(server/index.js)는 이미 .catch()로 감싸 로그만 남기므로 영향이 없고,
  // 관리자 수동 트리거(POST /api/admin/usage/sync)는 이걸 받아 기존 503 매핑을 태운다(설계 §18.7
  // "한 청크도 못 하면 503 UPSTREAM_UNAVAILABLE").
  if (attemptedChunks > 0 && committedDays.length === 0 && lastUpstreamErr) {
    throw lastUpstreamErr
  }

  const committedSet = new Set(committedDays)
  const remainingGapDays = targets.filter((d) => !committedSet.has(d)).sort()

  // C-1 수정 — 대상 날짜가 있는데 청크를 단 하나도 시도하지 못했으면(reserve 산술 오류·예산이
  // 지나치게 작음 등) 그 사실을 200 응답 안에 명시한다. 이전에는 이 상태가 "committed_days: []"로만
  // 나타나 성공(0일치 적재)과 구분되지 않았다 — 관리자가 몇 번을 눌러도 원인을 알 수 없었다.
  const noProgress = attemptedChunks === 0 && targets.length > 0

  const summary = {
    committed_days: committedDays.sort(),
    remaining_gap_days: remainingGapDays,
    elapsed_ms: Date.now() - startedAt,
    budget_exhausted: budgetExhausted,
    attempted_chunks: attemptedChunks,
    no_progress: noProgress,
    // M-3 — 마커를 아예 쓰지 않고 건너뛴 날짜(위 remaining_gap_days에도 포함됨). 상류 보관기간
    // 이전이라 "확인된 0"이라고 말할 근거가 없는 날 — 0으로 위조하지 않았다는 사실을 운영자가
    // 눈으로 확인할 수 있게 별도로도 노출한다.
    unresolved_days: unresolvedDays.sort()
  }
  if (noProgress) {
    console.error('[usage-rollup] no chunk attempted despite pending targets (reserveMs/budgetMs too tight?)', JSON.stringify({ budgetMs, reserveMs, targets: targets.length }))
  }
  console.log('[usage-rollup]', JSON.stringify(summary))
  return summary
}
