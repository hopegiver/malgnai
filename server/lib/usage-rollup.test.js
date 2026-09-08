// M-5 최소 단위테스트(리뷰 2026-09-03) — W1 불변식(Cron이 오늘을 롤업 대상에서 절대 포함하지 않는다,
// 설계 §19.3-1)을 순수하게 검증한다. D1은 전혀 열지 않는다 — '../dao/usage-prom-daily.js'를
// vi.mock으로 완전히 대체해 selectCoverageRange가 항상 결정론적인 값을 돌려주게 한다(네트워크·D1
// 의존 없음, PM 지시 범위 내).
import { describe, it, expect, vi } from 'vitest'
import { todayDayAt, addDays } from './day-boundary.js'
import { AGG_MODE, NORM_VERSION, IDENTITY_VERSION } from './usage-prom.js'

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
    const today = todayDayAt()
    expect(targets).not.toContain(today)
  })

  it('trailing rescan 구간(어제부터 최근 N일)은 커버리지 유무와 무관하게 항상 대상에 포함된다', async () => {
    const today = todayDayAt()
    const yesterday = addDays(today, -1)
    // 이미 유효 마커가 있어도(agg_mode/norm_version/identity_version 일치) trailing 구간은 무조건
    // 재적재 대상이다.
    selectCoverageRange.mockResolvedValueOnce([{ day_at: yesterday, agg_mode: AGG_MODE, norm_version: NORM_VERSION, identity_version: IDENTITY_VERSION, user_rows: 5 }])
    const targets = await computeTargetDays(fakeDb)
    expect(targets).toContain(yesterday)
  })

  it('horizon(ROLLUP_HORIZON_DAYS)보다 오래된 날짜는 대상에서 제외된다', async () => {
    selectCoverageRange.mockResolvedValueOnce([])
    const targets = await computeTargetDays(fakeDb)
    const today = todayDayAt()
    const beyondHorizon = addDays(today, -(ROLLUP_HORIZON_DAYS + 5))
    expect(targets).not.toContain(beyondHorizon)
  })

  it('유효 마커가 있는(agg_mode/norm_version/identity_version 전부 일치) 과거 날짜는 결손이 아니므로 대상에서 빠진다', async () => {
    const today = todayDayAt()
    const oldDay = addDays(today, -(ROLLUP_TRAILING_RESCAN_DAYS + 2))
    selectCoverageRange.mockResolvedValueOnce([{ day_at: oldDay, agg_mode: AGG_MODE, norm_version: NORM_VERSION, identity_version: IDENTITY_VERSION, user_rows: 3 }])
    const targets = await computeTargetDays(fakeDb)
    expect(targets).not.toContain(oldDay)
  })

  it('agg_mode/norm_version이 현재 값과 다른 과거 마커는 결손으로 간주해 재적재 대상에 포함된다', async () => {
    const today = todayDayAt()
    const staleDay = addDays(today, -(ROLLUP_TRAILING_RESCAN_DAYS + 2))
    // KST 전환(usage-kst-day-boundary.md §3 A안) — norm_version:'v1'은 이제 "옛 UTC 경계로 적재된
    // 행"을 뜻하는 레거시 값이다(NORM_VERSION은 'v2'로 승격됨). 이 테스트는 그 레거시 행이 결손으로
    // 재탐지되는 것을 검증한다 — 별도 시나리오를 새로 만들지 않고 기존 stale-marker 취지를 그대로
    // 살린다.
    selectCoverageRange.mockResolvedValueOnce([{ day_at: staleDay, agg_mode: 'old-mode', norm_version: 'v1', identity_version: IDENTITY_VERSION, user_rows: 3 }])
    const targets = await computeTargetDays(fakeDb)
    expect(targets).toContain(staleDay)
  })

  it('identity_version이 현재 IDENTITY_VERSION과 다른(레거시 employee_id 이전) 과거 마커는 결손으로 간주해 재적재 대상에 포함된다(usage-employee-identity.md §9.1)', async () => {
    const today = todayDayAt()
    const legacyDay = addDays(today, -(ROLLUP_TRAILING_RESCAN_DAYS + 2))
    // agg_mode/norm_version은 현재값과 일치하지만 identity_version만 'v0'(마이그레이션 0019 기본값,
    // employee_id 축 전환 이전 레거시)인 경우 — 읽기 판정(coveredDays)에는 여전히 잡히지만
    // 적재 대상 판정(isValidMarker)에서는 결손으로 취급돼 자동 재적재된다.
    selectCoverageRange.mockResolvedValueOnce([{ day_at: legacyDay, agg_mode: AGG_MODE, norm_version: NORM_VERSION, identity_version: 'v0', user_rows: 3 }])
    const targets = await computeTargetDays(fakeDb)
    expect(targets).toContain(legacyDay)
  })

  it('NORM_VERSION 승격(KST 전환) — 옛 v1 마커는 agg_mode/identity_version이 전부 일치해도 결손으로 재탐지된다(usage-kst-day-boundary.md §3)', async () => {
    const today = todayDayAt()
    const oldDay = addDays(today, -(ROLLUP_TRAILING_RESCAN_DAYS + 2))
    expect(NORM_VERSION).not.toBe('v1') // 이 테스트의 전제 — 승격 자체가 되돌려지면 여기서 바로 드러난다
    selectCoverageRange.mockResolvedValueOnce([{ day_at: oldDay, agg_mode: AGG_MODE, norm_version: 'v1', identity_version: IDENTITY_VERSION, user_rows: 3 }])
    const targets = await computeTargetDays(fakeDb)
    expect(targets).toContain(oldDay)
  })
})

// KST 경계를 걸치는 크론 회차 결정론적 테스트(usage-kst-day-boundary.md §10-C12~14) — nowMs를
// Date.parse(...)로 고정해 "지금"에 의존하지 않는다(현재시각 의존은 하루 중 특정 시간대에만 깨지는
// flaky 테스트가 된다, PM 지시). computeTargetDays(db, nowMs) 두 번째 인자가 이 결정론을 가능하게
// 한다 — 이 인자가 없던 기존 시그니처로는 이 describe 블록 자체를 쓸 수 없었다.
describe('computeTargetDays(db, nowMs) — KST 경계를 걸치는 크론 회차에서도 W1 불변식이 유지된다', () => {
  it("now=2026-09-08T18:01:00Z(주 적재 회차, KST 2026-09-09 03:01) — KST 오늘 '2026-09-09'는 절대 포함하지 않고 '2026-09-08'은 포함한다", async () => {
    selectCoverageRange.mockResolvedValueOnce([])
    const nowMs = Date.parse('2026-09-08T18:01:00Z')
    const targets = await computeTargetDays(fakeDb, nowMs)
    expect(targets).not.toContain('2026-09-09')
    expect(targets).toContain('2026-09-08')
  })

  it("now=2026-09-08T00:59:00Z(보조 재시도 회차, KST 2026-09-08 09:59) — 동일 불변식: '2026-09-08' 미포함, '2026-09-07' 포함", async () => {
    selectCoverageRange.mockResolvedValueOnce([])
    const nowMs = Date.parse('2026-09-08T00:59:00Z')
    const targets = await computeTargetDays(fakeDb, nowMs)
    expect(targets).not.toContain('2026-09-08')
    expect(targets).toContain('2026-09-07')
  })

  it('KST 자정(=15:00Z) 1분 전/후 두 시점에서 대상 집합이 정확히 하루씩 이동한다', async () => {
    selectCoverageRange.mockResolvedValueOnce([])
    const before = await computeTargetDays(fakeDb, Date.parse('2026-09-08T14:59:00Z')) // KST 09-08 23:59
    selectCoverageRange.mockResolvedValueOnce([])
    const after = await computeTargetDays(fakeDb, Date.parse('2026-09-08T15:01:00Z')) // KST 09-09 00:01

    expect(before).not.toContain('2026-09-08')
    expect(before).toContain('2026-09-07')
    expect(after).not.toContain('2026-09-09')
    expect(after).toContain('2026-09-08')
    // 두 시점 사이 1초를 사이에 두고 "오늘/어제"가 정확히 하루 이동했다 — 그 외 대상 집합(trailing
    // 창 전체)도 함께 하루씩 밀린다.
    expect(before).not.toEqual(after)
  })
})
