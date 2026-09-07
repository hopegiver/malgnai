// M-5 최소 단위테스트(리뷰 2026-09-03) — W1 불변식(Cron이 오늘을 롤업 대상에서 절대 포함하지 않는다,
// 설계 §19.3-1)을 순수하게 검증한다. D1은 전혀 열지 않는다 — '../dao/usage-prom-daily.js'를
// vi.mock으로 완전히 대체해 selectCoverageRange가 항상 결정론적인 값을 돌려주게 한다(네트워크·D1
// 의존 없음, PM 지시 범위 내).
import { describe, it, expect, vi } from 'vitest'
import { todayUTCString, addDaysUTC } from './utc-day.js'

vi.mock('../dao/usage-prom-daily.js', () => ({
  selectCoverageRange: vi.fn(async () => []) // 기본: 커버리지 없음(완전 신규 배포 시나리오)
}))

const { selectCoverageRange } = await import('../dao/usage-prom-daily.js')
const { computeTargetDays, ROLLUP_TRAILING_RESCAN_DAYS, ROLLUP_HORIZON_DAYS } = await import('./usage-rollup.js')

const fakeDb = {} // computeTargetDays는 db를 그대로 selectCoverageRange에 넘기기만 한다(모킹됨)

describe('computeTargetDays — W1 불변식(오늘은 절대 롤업 대상이 아니다, 설계 §19.3-1)', () => {
  it('커버리지가 하나도 없어도 오늘 날짜는 targets에 포함되지 않는다', async () => {
    selectCoverageRange.mockResolvedValueOnce([])
    const targets = await computeTargetDays(fakeDb)
    const today = todayUTCString()
    expect(targets).not.toContain(today)
  })

  it('trailing rescan 구간(어제부터 최근 N일)은 커버리지 유무와 무관하게 항상 대상에 포함된다', async () => {
    const today = todayUTCString()
    const yesterday = addDaysUTC(today, -1)
    // 이미 유효 마커가 있어도(agg_mode/norm_version/identity_version 일치) trailing 구간은 무조건
    // 재적재 대상이다.
    selectCoverageRange.mockResolvedValueOnce([{ day_at: yesterday, agg_mode: 'increase', norm_version: 'v1', identity_version: 'v1', user_rows: 5 }])
    const targets = await computeTargetDays(fakeDb)
    expect(targets).toContain(yesterday)
  })

  it('horizon(ROLLUP_HORIZON_DAYS)보다 오래된 날짜는 대상에서 제외된다', async () => {
    selectCoverageRange.mockResolvedValueOnce([])
    const targets = await computeTargetDays(fakeDb)
    const today = todayUTCString()
    const beyondHorizon = addDaysUTC(today, -(ROLLUP_HORIZON_DAYS + 5))
    expect(targets).not.toContain(beyondHorizon)
  })

  it('유효 마커가 있는(agg_mode/norm_version/identity_version 전부 일치) 과거 날짜는 결손이 아니므로 대상에서 빠진다', async () => {
    const today = todayUTCString()
    const oldDay = addDaysUTC(today, -(ROLLUP_TRAILING_RESCAN_DAYS + 2))
    selectCoverageRange.mockResolvedValueOnce([{ day_at: oldDay, agg_mode: 'increase', norm_version: 'v1', identity_version: 'v1', user_rows: 3 }])
    const targets = await computeTargetDays(fakeDb)
    expect(targets).not.toContain(oldDay)
  })

  it('agg_mode/norm_version이 현재 값과 다른 과거 마커는 결손으로 간주해 재적재 대상에 포함된다', async () => {
    const today = todayUTCString()
    const staleDay = addDaysUTC(today, -(ROLLUP_TRAILING_RESCAN_DAYS + 2))
    selectCoverageRange.mockResolvedValueOnce([{ day_at: staleDay, agg_mode: 'old-mode', norm_version: 'v0', identity_version: 'v1', user_rows: 3 }])
    const targets = await computeTargetDays(fakeDb)
    expect(targets).toContain(staleDay)
  })

  it('identity_version이 현재 IDENTITY_VERSION과 다른(레거시 employee_id 이전) 과거 마커는 결손으로 간주해 재적재 대상에 포함된다(usage-employee-identity.md §9.1)', async () => {
    const today = todayUTCString()
    const legacyDay = addDaysUTC(today, -(ROLLUP_TRAILING_RESCAN_DAYS + 2))
    // agg_mode/norm_version은 현재값과 일치하지만 identity_version만 'v0'(마이그레이션 0019 기본값,
    // employee_id 축 전환 이전 레거시)인 경우 — 읽기 판정(coveredDays)에는 여전히 잡히지만
    // 적재 대상 판정(isValidMarker)에서는 결손으로 취급돼 자동 재적재된다.
    selectCoverageRange.mockResolvedValueOnce([{ day_at: legacyDay, agg_mode: 'increase', norm_version: 'v1', identity_version: 'v0', user_rows: 3 }])
    const targets = await computeTargetDays(fakeDb)
    expect(targets).toContain(legacyDay)
  })
})
