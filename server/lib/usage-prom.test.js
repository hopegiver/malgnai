// M-5 최소 단위테스트(리뷰 2026-09-03, review-usage-prometheus-hybrid-2026-09-03.md) — 이 변경의
// 핵심 불변식(이음매 W1/W2, off-by-one, gap_days 정직성, PromQL 인젝션 방지)은 이전에 전부 정적
// 추론으로만 검증돼 있었다. 외부 네트워크·D1 의존 없이 도는 순수 함수만 대상으로 한다(통합/E2E는
// 이번 범위 밖 — PM 지시).
import { describe, it, expect, vi } from 'vitest'
import { todayDayAt } from './day-boundary.js'

// M-3 회귀(리뷰 2026-09-08, usage-kst-day-boundary.md) — usage-prom.js는 './prom-client.js'의
// runQueriesInWaves로 상류를 부른다. 아래 "[핵심]" 테스트만 이 함수를 스텁으로 대체해 네트워크 없이
// getUsageOverview()의 instant(오늘 부분일) 병합 경로를 끝까지 태운다 — 나머지 export(PROM_CACHE_TTL_
// SECONDS 등)는 실제 구현 그대로 둔다.
vi.mock('./prom-client.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, runQueriesInWaves: vi.fn() }
})

const {
  AGG_MODE,
  NORM_VERSION,
  promTimestampToDayAt,
  dayGridWindow,
  todayPartialWindow,
  computeLiveCompleteWindow,
  computeGapDays,
  isPromSafeEmail,
  unitKeyOf,
  rowKeyOf,
  foldToEmployees,
  groupAccountsOf,
  mergeD1AndPromUsers,
  daySummaryRows,
  zeroTotals,
  getUsageOverviewHybrid,
  getUsageOverview,
  fetchCompletedDayGrid
} = await import('./usage-prom.js')
const { runQueriesInWaves } = await import('./prom-client.js')

// 화요일, 10:00Z — KST 자정 경계(15:00Z)보다 한참 이르므로 KST 전환 후에도 todayDayAt(NOW)는
// 여전히 '2026-09-03'이다(UTC 날짜와 KST 날짜가 우연히 같은 시각을 골랐다, KST 전환 §6.1).
const NOW = Date.parse('2026-09-03T10:00:00Z')

describe('promTimestampToDayAt — off-by-one 매핑(설계 §4.2, KST 전환 §6.1)', () => {
  it('버킷 정각(UTC 자정)은 그 전날로 매핑된다 — KST 오프셋과 무관하게 여전히 성립(경계에서 먼 임의 시각)', () => {
    const t = Date.parse('2026-09-03T00:00:00Z') / 1000
    expect(promTimestampToDayAt(t)).toBe('2026-09-02')
  })

  // KST 전환(usage-kst-day-boundary.md §10-B8, §13) — 이 파일의 진짜 경계는 UTC 자정(00:00Z)이
  // 아니라 KST 자정(=15:00Z)이다. 아래 두 테스트는 그 경계 바로 옆(14:59:59Z/15:00:00Z)에서
  // "하루 밀림"이 정확히 일어나는지를 검증한다 — 옛 테스트는 UTC 자정 부근(23:59:59Z/00:00:00Z)을
  // 썼는데, KST 전환 후에는 그 지점이 더 이상 실제 경계가 아니라서 "하루 밀림" 명제 자체가 거짓이
  // 된다(23:59:59Z는 이미 다음 KST 날짜의 한복판이다).
  it('KST 자정(=15:00Z) 1초 전은 그 전날(KST)로 매핑된다', () => {
    const t = Date.parse('2026-09-03T14:59:59Z') / 1000
    expect(promTimestampToDayAt(t)).toBe('2026-09-02')
  })

  it('KST 자정(=15:00Z) 정각을 한 틱 넘기면 매핑도 정확히 하루만 밀린다 — 1초 차이로 다른 날짜', () => {
    const before = Date.parse('2026-09-03T14:59:59Z') / 1000
    const after = Date.parse('2026-09-03T15:00:00Z') / 1000
    expect(promTimestampToDayAt(before)).toBe('2026-09-02')
    expect(promTimestampToDayAt(after)).toBe('2026-09-03')
  })
})

describe('dayGridWindow — 완결일 그리드 경계(설계 §4.2·§4.3, KST 앵커 전환 §6.1 A안)', () => {
  it('from=to=오늘(KST)이면 완결된 버킷이 없어 null(오늘분은 별도 instant 질의로 얹는다)', () => {
    expect(dayGridWindow('2026-09-03', '2026-09-03', NOW)).toBeNull()
  })

  it('to가 오늘이면(to+1일이 오늘을 넘으므로) end가 "KST 오늘 자정"(=전날 15:00Z)으로 클램프된다', () => {
    const grid = dayGridWindow('2026-08-30', '2026-09-03', NOW)
    const kstTodayStartSec = Date.parse('2026-09-02T15:00:00Z') / 1000
    expect(grid.end).toBe(kstTodayStartSec)
  })

  it('완전한 과거 구간은 start/end가 KST 자정(=매일 15:00Z) 앵커에서 정확히 하루(+1일) 밀려서 계산된다', () => {
    const grid = dayGridWindow('2026-08-01', '2026-08-07', NOW)
    expect(grid.start).toBe(Date.parse('2026-08-01T15:00:00Z') / 1000)
    expect(grid.end).toBe(Date.parse('2026-08-07T15:00:00Z') / 1000)
    expect(grid.step).toBe(86400)
  })

  // 완료판정(usage-kst-day-boundary.md §10-B7) — A안(KST 앵커 그리드) 채택의 정의 그 자체: 그리드
  // start/end는 항상 KST 자정(=UTC 15:00) 위에 있어야 한다. 상류 step 정렬 게이트 실측은 사람이
  // 배포 후 눈으로 확인할 몫이지만(설계 §6.3, §10-F22), 이 앵커 산술 자체는 여기서 결정론적으로
  // 잠근다.
  it('start와 end 둘 다 KST 자정 위에 있다(mod 86400 === 54000, 15:00Z = 54000초)', () => {
    const grid = dayGridWindow('2026-08-01', '2026-08-07', NOW)
    expect(grid.start % 86400).toBe(54000)
    expect(grid.end % 86400).toBe(54000)
  })
})

describe('todayPartialWindow — 오늘 부분일 경계(설계 §4.3, M-2 TTL 버킷팅)', () => {
  it('to가 오늘보다 과거면 질의 자체를 생략(null)', () => {
    expect(todayPartialWindow('2026-09-02', NOW)).toBeNull()
  })

  it('to가 오늘이면 60초 버킷으로 내림된 time/rangeSeconds를 반환(KST 자정 기준)', () => {
    const win = todayPartialWindow('2026-09-03', NOW)
    expect(win).not.toBeNull()
    // NOW=10:00:00Z는 이미 60초 배수라 버킷 경계와 정확히 일치한다.
    expect(win.time).toBe(Math.floor(NOW / 1000))
    // KST 전환(§6.1) — 경과시간은 이제 UTC 자정이 아니라 KST 자정(=전날 15:00Z)부터다.
    // 2026-09-02T15:00:00Z → 2026-09-03T10:00:00Z(NOW) = 19시간. 회귀 방지: UTC 계산이 남아 있으면
    // 이 값이 10시간(10*3600)으로 잘못 나온다(설계 §10-B9).
    expect(win.rangeSeconds).toBe(19 * 3600)
  })

  it('같은 60초 버킷 안의 서로 다른 nowMs는 완전히 같은 time/rangeSeconds를 낸다(M-2 캐시 키 안정성)', () => {
    const nowA = Date.parse('2026-09-03T10:00:05Z')
    const nowB = Date.parse('2026-09-03T10:00:55Z')
    const winA = todayPartialWindow('2026-09-03', nowA)
    const winB = todayPartialWindow('2026-09-03', nowB)
    expect(winA).toEqual(winB)
  })

  it('60초 버킷 경계를 넘어가면 time이 정확히 60초만큼만 전진한다(정확도 손실 없음)', () => {
    const nowA = Date.parse('2026-09-03T10:00:59Z')
    const nowB = Date.parse('2026-09-03T10:01:00Z')
    const winA = todayPartialWindow('2026-09-03', nowA)
    const winB = todayPartialWindow('2026-09-03', nowB)
    expect(winB.time - winA.time).toBe(60)
  })
})

// M-3 회귀(리뷰 2026-09-08, usage-kst-day-boundary.md M-3) — 위 NOW(2026-09-03T10:00:00Z)는 UTC
// 날짜와 KST 날짜가 우연히 같은 시각이라(주석 참고) 이 파일의 그리드/부분일 테스트는 전부 그 경로를
// 겨냥하지 못한다. 아래는 UTC 날짜('2026-09-08')와 KST 날짜('2026-09-09')가 실제로 갈리는 시각에서만
// 재현되는 경계를 겨냥한다.
describe('M-3 회귀 — KST 자정을 넘겨 UTC 날짜와 KST 날짜가 갈리는 시각(usage-kst-day-boundary.md M-3)', () => {
  // KST 2026-09-09 01:00 = UTC 2026-09-08 16:00.
  const NOW_KST_EARLY = Date.parse('2026-09-08T16:00:00Z')

  it('전제: todayDayAt(NOW_KST_EARLY)는 KST 오늘("2026-09-09")이지 UTC 오늘("2026-09-08")이 아니다', () => {
    expect(todayDayAt(NOW_KST_EARLY)).toBe('2026-09-09')
  })

  it('(a) dayGridWindow — 이 시각에도 그리드 끝은 KST 자정(=전날 15:00Z)으로 클램프된다', () => {
    const grid = dayGridWindow('2026-09-08', '2026-09-09', NOW_KST_EARLY)
    expect(grid).not.toBeNull()
    // UTC로 계산했다면 "오늘 UTC"는 이미 '2026-09-08'이라 end가 하루 더 전으로(08-07 15:00Z 부근으로)
    // 잘못 클램프됐을 것 — KST 계산이면 '2026-09-09' KST 자정(=이 시각)에서 클램프된다.
    expect(grid.end).toBe(Date.parse('2026-09-08T15:00:00Z') / 1000)
  })

  it('(a) todayPartialWindow — 경과시간이 KST 자정 이후 1시간(3600초)이다(UTC 계산이면 16시간=57600초가 된다)', () => {
    const win = todayPartialWindow('2026-09-09', NOW_KST_EARLY)
    expect(win).not.toBeNull()
    expect(win.rangeSeconds).toBe(3600)
  })

  // (b) — 핵심. runOverviewSpecsAndMerge(getUsageOverview 경유)를 상류 스텁으로 실제로 태워, instant
  // (오늘 부분일) 결과에 붙는 day_at이 KST 오늘인지를 단언한다. 이 경로를 도는 테스트가 이전에는 0개였다
  // — todayLabel = todayDayAt(nowMs)(usage-prom.js:366)가 new Date(nowMs).toISOString().slice(0,10)로
  // "단순화"돼도 위 (a) 두 테스트는 여전히 통과하지만(그 함수들은 todayLabel을 안 씀) 이 테스트는 실패한다.
  it('[핵심] getUsageOverview의 instant 병합 결과 day_at이 KST 오늘("2026-09-09")이다 — todayLabel이 UTC로 되돌아가면 이 테스트가 실패해야 한다', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_KST_EARLY)
    try {
      const fakeMeta = () => ({ hit: true, age_seconds: 0, ttl_seconds: 60, stale: false, fetched_at: new Date().toISOString(), refresh_throttled: false })
      runQueriesInWaves.mockResolvedValueOnce([
        { data: [{ metric: { employee_id: 'self', user_email: 'self@malgnsoft.com', type: 'input' }, value: [Math.floor(NOW_KST_EARLY / 1000), '55'] }], meta: fakeMeta() },
        { data: [], meta: fakeMeta() },
        { data: [], meta: fakeMeta() }
      ])

      const result = await getUsageOverview({}, { from: '2026-09-09', to: '2026-09-09', refresh: false })

      const entry = result.byUnit.get(unitKeyOf('self', 'self@malgnsoft.com'))
      expect(entry).toBeDefined()
      expect(entry.days.has('2026-09-09')).toBe(true) // KST 오늘로 붙어야 한다
      expect(entry.days.has('2026-09-08')).toBe(false) // UTC 오늘로 잘못 붙으면 여기서 걸린다
    } finally {
      vi.useRealTimers()
    }
  })
})

// 런타임 가드(reviewer M-4/R-1, 승인됨) — KST 앵커 그리드(A안)는 "상류가 query_range의 start를 step
// 배수로 내림 정렬하지 않는다"는 실측 관측에 의존한다(계약이 아니다). 상류가 정렬을 시작하면
// promTimestampToDayAt이 검증 없이 그 타임스탬프를 받아 값은 총합 보존된 채 day_at 라벨만 9시간 밀린
// UTC 버킷으로 조용히 되돌아간다 — 캐시·라이브가 함께 밀려 이음매 불연속조차 안 생기는 무증상 오류다.
// 아래는 그 사실이 gridAnchorMismatch로 탐지되고(오탐 없이), console.error가 요청마다 도배되지 않고
// 딱 1회만 찍히는지를 검증한다. runOverviewSpecsAndMerge가 라이브(getUsageOverview)와 Cron 적재
// (fetchCompletedDayGrid) 양쪽의 유일한 공유 병합 지점이므로, getUsageOverview 경로 하나만 스텁으로
// 태워도 두 경로에 공통으로 적용되는 탐지 로직 자체를 검증하는 셈이다 — fetchCompletedDayGrid 쪽은
// 별도 테스트로 "그 반환값에도 실제로 실린다"만 다시 확인한다(로직 중복 검증이 아니라 배선 검증).
describe('KST 앵커 런타임 가드(reviewer M-4/R-1) — 탐지만 하고 절대 보정하지 않는다', () => {
  const FROM = '2026-08-01'
  const TO = '2026-08-07'
  const grid = dayGridWindow(FROM, TO, NOW)
  const fakeMeta = () => ({ hit: true, age_seconds: 0, ttl_seconds: 60, stale: false, fetched_at: new Date().toISOString(), refresh_throttled: false })

  function gridResults(firstTimestampSec) {
    const series = { metric: { employee_id: 'self', user_email: 'self@malgnsoft.com', type: 'input' }, values: [[firstTimestampSec, '10']] }
    return [
      { data: [series], meta: fakeMeta() }, // tokensGrid
      { data: [], meta: fakeMeta() },       // sessionsGrid
      { data: [], meta: fakeMeta() }        // costGrid
    ]
  }

  it('전제: 완결 구간 그리드는 KST 자정 앵커(mod 86400 === 54000) 위에 있다', () => {
    expect(grid.start % 86400).toBe(54000)
  })

  it('KST 앵커에 정렬된 정상 응답은 가드가 발동하지 않는다(오탐 없음) — gridAnchorMismatch:false, console.error 미호출', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      runQueriesInWaves.mockResolvedValueOnce(gridResults(grid.start))
      const result = await getUsageOverview({}, { from: FROM, to: TO, refresh: false })
      expect(result.gridAnchorMismatch).toBe(false)
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it('상류가 UTC 자정으로 정렬한 응답(mod 86400 === 0, 현실적인 정렬 사고 케이스)은 가드가 발동한다 — gridAnchorMismatch:true + console.error 1회, 두 번째 요청부터는 로그 도배 없이 값만 계속 true', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const utcMidnight = grid.start - 54000 // KST 자정(54000) → UTC 자정(mod 0)으로 정렬됐다고 가정
      expect(utcMidnight % 86400).toBe(0)

      runQueriesInWaves.mockResolvedValueOnce(gridResults(utcMidnight))
      const result1 = await getUsageOverview({}, { from: FROM, to: TO, refresh: false })
      expect(result1.gridAnchorMismatch).toBe(true)
      expect(errSpy).toHaveBeenCalledTimes(1)

      // 요청마다 도배하지 않는다(요구사항) — 같은 프로세스 안에서 두 번째 misaligned 요청은 탐지값은
      // 계속 true로 노출하되(조용히 사라지지 않는다), console.error는 다시 찍지 않는다.
      runQueriesInWaves.mockResolvedValueOnce(gridResults(utcMidnight))
      const result2 = await getUsageOverview({}, { from: FROM, to: TO, refresh: false })
      expect(result2.gridAnchorMismatch).toBe(true)
      expect(errSpy).toHaveBeenCalledTimes(1) // 여전히 1회 — 도배 없음
    } finally {
      errSpy.mockRestore()
    }
  })

  it('Cron 적재 경로(fetchCompletedDayGrid)도 같은 공유 함수를 거치므로 반환값에 gridAnchorMismatch가 그대로 실린다(배선 확인)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const utcMidnight = grid.start - 54000
      runQueriesInWaves.mockResolvedValueOnce(gridResults(utcMidnight))
      const result = await fetchCompletedDayGrid({}, { from: FROM, to: TO })
      expect(result.gridAnchorMismatch).toBe(true)
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('computeLiveCompleteWindow — W2 불변식(캐시된 날을 재조회하지 않는다, 설계 §19.3)', () => {
  it('anchor(어제)가 이미 캐시에 있으면 즉시 null — 라이브 창이 생기지 않는다', () => {
    const win = computeLiveCompleteWindow({
      from: '2026-08-01',
      anchor: '2026-09-02',
      coveredDays: new Set(['2026-09-02']),
      maxDays: 2
    })
    expect(win).toBeNull()
  })

  it('캐시가 전혀 없으면 anchor부터 최대 maxDays일만 거꾸로 채운다', () => {
    const win = computeLiveCompleteWindow({
      from: '2026-08-01',
      anchor: '2026-09-02',
      coveredDays: new Set(),
      maxDays: 2
    })
    expect(win).toEqual({ from: '2026-09-01', to: '2026-09-02' })
  })

  it('캐시된 날을 만나면 그 날은 포함하지 않고 즉시 멈춘다(재조회 금지)', () => {
    // 09-01은 이미 캐시됨 — 라이브 창은 09-02 하루만이어야 한다.
    const win = computeLiveCompleteWindow({
      from: '2026-08-01',
      anchor: '2026-09-02',
      coveredDays: new Set(['2026-09-01']),
      maxDays: 2
    })
    expect(win).toEqual({ from: '2026-09-02', to: '2026-09-02' })
  })

  it('anchor가 from보다 과거면 null', () => {
    const win = computeLiveCompleteWindow({ from: '2026-09-05', anchor: '2026-09-02', coveredDays: new Set(), maxDays: 2 })
    expect(win).toBeNull()
  })
})

describe('computeGapDays — 결손을 0으로 위장하지 않는다(설계 §20.1)', () => {
  it('캐시로도 라이브로도 못 채운 날짜만, 정확히 그 문자열만 반환한다(0 행을 만들지 않는다)', () => {
    const covered = new Set(['2026-08-30', '2026-08-31'])
    const liveCovered = new Set(['2026-09-02'])
    const gaps = computeGapDays('2026-08-30', '2026-09-02', covered, liveCovered)
    expect(gaps).toEqual(['2026-09-01'])
  })

  it('전 구간이 커버되면 빈 배열(gap 없음)', () => {
    const covered = new Set(['2026-08-30', '2026-08-31', '2026-09-01'])
    const gaps = computeGapDays('2026-08-30', '2026-09-01', covered, new Set())
    expect(gaps).toEqual([])
  })

  it('전 구간이 결손이면 그 구간 전체가 그대로 gap_days로 나온다(값이 아니라 날짜 목록)', () => {
    const gaps = computeGapDays('2026-07-25', '2026-07-27', new Set(), new Set())
    expect(gaps).toEqual(['2026-07-25', '2026-07-26', '2026-07-27'])
  })
})

describe('isPromSafeEmail — PromQL 라벨 인젝션 방지(설계 §4.7)', () => {
  it('정상 이메일은 통과', () => {
    expect(isPromSafeEmail('dev@malgnsoft.com')).toBe(true)
  })

  it.each([
    ['공백 포함', 'a b@malgnsoft.com'],
    ['큰따옴표 포함(라벨 매처 탈출 시도)', 'a"@malgnsoft.com'],
    ['백슬래시 포함(이스케이프 조작 시도)', 'a\\@malgnsoft.com'],
    ['중괄호 포함(새 매처 삽입 시도)', 'a{user_email=~".*"}@malgnsoft.com'],
    ['@ 없음', 'not-an-email'],
    ['빈 문자열', ''],
    ['문자열이 아님(null)', null],
    ['문자열이 아님(숫자)', 12345]
  ])('%s → 거부', (_label, value) => {
    expect(isPromSafeEmail(value)).toBe(false)
  })
})

// resolveEmailScope의 순수 판정 로직은 usage-identity.js의 resolveEmployeeScope로 이전됐다
// (docs/design/usage-employee-identity.md §3.4·§6.1) — 그 단위테스트는 server/lib/usage-identity.test.js
// 에 있다. 아래부터는 이 전환으로 새로 생긴 usage-prom.js 함수들(unitKeyOf/foldToEmployees/
// mergeD1AndPromUsers/daySummaryRows)의 단위테스트다.

function unit({ employeeId = null, userEmail = null, names = [], days = [] }) {
  return { employeeId, userEmail, employeeNames: new Set(names), days: new Map(days) }
}

function dayValues(overrides = {}) {
  return { session_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, ...overrides }
}

describe('unitKeyOf/rowKeyOf — unit·응답 행 키 구조(usage-employee-identity.md §5.1)', () => {
  it('employeeId·userEmail 쌍이 다르면 서로 다른 unitKey를 만든다("a"+"b@x" 대 "ab"+"@x" 충돌 불가)', () => {
    const k1 = unitKeyOf('a', 'b@x')
    const k2 = unitKeyOf('ab', '@x')
    expect(k1).not.toBe(k2)
  })

  it('rowKeyOf — employee_id 있으면 emp:, 없고 user_email만 있으면 grp:, 둘 다 없으면 unk:(N2)', () => {
    expect(rowKeyOf('hopegiver', 'dev@malgnsoft.com')).toBe('emp:hopegiver')
    expect(rowKeyOf(null, 'public@malgnsoft.com')).toBe('grp:public@malgnsoft.com')
    expect(rowKeyOf(null, null)).toBe('unk:')
  })
})

describe('foldToEmployees — unit(employee_id×user_email) → 직원 단위 접기(§5.1·§5.3)', () => {
  it('같은 직원이 그룹 계정 2개를 쓰면 1행으로 접히고 group_accounts에 2건이 들어간다(N3)', () => {
    const byUnit = new Map([
      [unitKeyOf('hopegiver', 'dev@malgnsoft.com'), unit({
        employeeId: 'hopegiver', userEmail: 'dev@malgnsoft.com',
        days: [['2026-09-01', dayValues({ input_tokens: 100, output_tokens: 10 })]]
      })],
      [unitKeyOf('hopegiver', 'ai@malgnsoft.com'), unit({
        employeeId: 'hopegiver', userEmail: 'ai@malgnsoft.com',
        days: [['2026-09-01', dayValues({ input_tokens: 5, output_tokens: 1 })]]
      })]
    ])
    const employees = foldToEmployees(byUnit, new Map())
    expect(employees.size).toBe(1)
    const emp = employees.get('emp:hopegiver')
    expect(emp.days.get('2026-09-01').input_tokens).toBe(105) // 두 계정 합산
    const accounts = groupAccountsOf(emp)
    expect(accounts).toHaveLength(2)
    expect(accounts.map((a) => a.user_email).sort()).toEqual(['ai@malgnsoft.com', 'dev@malgnsoft.com'])
  })

  it('employee_id 없는 관측치는 버리지 않고 grp: 행으로 접힌다(§5.2 폴백)', () => {
    const byUnit = new Map([
      [unitKeyOf(null, 'public@malgnsoft.com'), unit({ employeeId: null, userEmail: 'public@malgnsoft.com', days: [['2026-09-01', dayValues({ input_tokens: 50 })]] })]
    ])
    const employees = foldToEmployees(byUnit, new Map())
    const emp = employees.get('grp:public@malgnsoft.com')
    expect(emp).toBeDefined()
    expect(emp.identitySource).toBe('group_account')
    expect(emp.days.get('2026-09-01').input_tokens).toBe(50)
  })

  it('employee_id·user_email 둘 다 없는 관측치는 unk: 단일 행으로 모인다(N2, 최대 1행)', () => {
    const byUnit = new Map([
      [unitKeyOf(null, null), unit({ days: [['2026-09-01', dayValues({ input_tokens: 7 })]] })]
    ])
    const employees = foldToEmployees(byUnit, new Map())
    expect(employees.size).toBe(1)
    expect(employees.get('unk:').identitySource).toBe('unknown')
    expect(groupAccountsOf(employees.get('unk:'))).toEqual([]) // 계정 자체가 없으므로 빈 배열
  })
})

describe('mergeD1AndPromUsers — D1 users.employee_id 컬럼이 병합 축(usage-employee-identity-linking.md §7.1)', () => {
  it('D1 users.employee_id 컬럼 값을 그대로 병합 키로 쓴다(이메일 로컬파트 파생 없음)', () => {
    // 이메일 로컬파트는 'djkim'이지만 employee_id 컬럼은 'malgn'로 연동된 실측 사례(§1) — 컬럼이
    // 단일 정본이므로 로컬파트가 아니라 컬럼 값('malgn')으로 매칭돼야 한다.
    const d1Users = [{ id: 'u1', email: 'djkim@malgnsoft.com', name: '김덕조', role: 'administrator', status: 'active', employee_id: 'malgn' }]
    const byUnit = new Map([
      [unitKeyOf('malgn', 'public@malgnsoft.com'), unit({ employeeId: 'malgn', userEmail: 'public@malgnsoft.com', days: [['2026-09-01', dayValues({ input_tokens: 42 })]] })]
    ])
    const rows = mergeD1AndPromUsers(d1Users, byUnit, new Map())
    expect(rows).toHaveLength(1)
    expect(rows[0].row_key).toBe('emp:malgn')
    expect(rows[0].employee_id).toBe('malgn')
    expect(rows[0].total_tokens).toBe(42)
  })

  it('employee_id가 NULL(미연동)인 D1 사용자는 d1only: 행으로 사용량 0으로 뜬다(§7.1 신규 추가 행)', () => {
    const d1Users = [{ id: 'u1', email: 'djkim@malgnsoft.com', name: '김덕조', role: 'administrator', status: 'active', employee_id: null }]
    const rows = mergeD1AndPromUsers(d1Users, new Map(), new Map())
    expect(rows).toHaveLength(1)
    expect(rows[0].row_key).toBe('d1only:u1')
    expect(rows[0].employee_id).toBeNull()
    expect(rows[0].total_tokens).toBe(0)
    expect(rows[0].identity_source).toBeNull()
  })

  it('로컬파트 충돌 개념 자체가 사라졌다 — 같은 로컬파트를 가진 두 사용자도 employee_id 컬럼이 다르면 정상 병합된다(§3.3 폐기)', () => {
    const d1Users = [
      { id: 'u1', email: 'dup@malgnsoft.com', name: '충돌1', role: 'employee', status: 'active', employee_id: 'dup' },
      { id: 'u2', email: 'DUP@malgnsoft.com', name: '충돌2', role: 'employee', status: 'active', employee_id: null } // 컬럼은 미연동이라 실제 충돌 없음
    ]
    const byUnit = new Map([
      [unitKeyOf('dup', 'dup@malgnsoft.com'), unit({ employeeId: 'dup', userEmail: 'dup@malgnsoft.com', days: [['2026-09-01', dayValues({ input_tokens: 999 })]] })]
    ])
    const rows = mergeD1AndPromUsers(d1Users, byUnit, new Map())
    const u1Row = rows.find((r) => r.user_id === 'u1')
    const u2Row = rows.find((r) => r.user_id === 'u2')
    expect(u1Row.total_tokens).toBe(999)
    expect(u1Row.identity_ambiguous).toBeUndefined()
    expect(u2Row.total_tokens).toBe(0)
  })

  it('허브 계정에 연결되지 않은 관측치(employee_id가 어떤 D1 사용자에게도 없음)는 prometheus_only 행으로 분리된다(총합 보존)', () => {
    const d1Users = [{ id: 'u1', email: 'hopegiver@malgnsoft.com', name: '하근호', role: 'administrator', status: 'active', employee_id: 'hopegiver' }]
    const byUnit = new Map([
      [unitKeyOf('claude', 'public@malgnsoft.com'), unit({ employeeId: 'claude', userEmail: 'public@malgnsoft.com', names: ['김도형'], days: [['2026-09-01', dayValues({ input_tokens: 88 })]] })]
    ])
    const rows = mergeD1AndPromUsers(d1Users, byUnit, new Map())
    const promOnlyRow = rows.find((r) => r.source === 'prometheus_only')
    expect(promOnlyRow).toBeDefined()
    expect(promOnlyRow.employee_id).toBe('claude')
    expect(promOnlyRow.total_tokens).toBe(88) // 값 자체는 사라지지 않는다(총합 보존)
    expect(promOnlyRow.user_id).toBeNull()
    expect(promOnlyRow.observed_employee_name).toBe('김도형')
    expect(promOnlyRow.observed_name_mismatch).toBe(false)
  })

  describe('observed_employee_name / observed_name_mismatch — 오연결 탐지 신호(§4.4 S4)', () => {
    it('관측 이름이 D1 이름과 다르면 observed_name_mismatch:true(오연결 경고)', () => {
      // djkim@(김덕조)에게 실수로 이진화가 관측되는 축('public')을 붙인 사고 시나리오(§1 실측 사례 유사)
      const d1Users = [{ id: 'u1', email: 'djkim@malgnsoft.com', name: '김덕조', role: 'administrator', status: 'active', employee_id: 'public' }]
      const byUnit = new Map([
        [unitKeyOf('public', 'public@malgnsoft.com'), unit({ employeeId: 'public', userEmail: 'public@malgnsoft.com', names: ['이진화'], days: [['2026-09-01', dayValues({ input_tokens: 10 })]] })]
      ])
      const rows = mergeD1AndPromUsers(d1Users, byUnit, new Map())
      expect(rows[0].observed_employee_name).toBe('이진화')
      expect(rows[0].observed_name_mismatch).toBe(true)
    })

    it('관측 이름이 D1 이름과 같으면 mismatch:false', () => {
      const d1Users = [{ id: 'u1', email: 'hopegiver@malgnsoft.com', name: '하근호', role: 'employee', status: 'active', employee_id: 'hopegiver' }]
      const byUnit = new Map([
        [unitKeyOf('hopegiver', 'dev@malgnsoft.com'), unit({ employeeId: 'hopegiver', userEmail: 'dev@malgnsoft.com', names: ['하근호'], days: [['2026-09-01', dayValues({ input_tokens: 10 })]] })]
      ])
      const rows = mergeD1AndPromUsers(d1Users, byUnit, new Map())
      expect(rows[0].observed_name_mismatch).toBe(false)
    })

    it('관측 이름이 없으면(employee_name 라벨 없음) observed_employee_name:null, mismatch:false', () => {
      const d1Users = [{ id: 'u1', email: 'hopegiver@malgnsoft.com', name: '하근호', role: 'employee', status: 'active', employee_id: 'hopegiver' }]
      const byUnit = new Map([
        [unitKeyOf('hopegiver', 'dev@malgnsoft.com'), unit({ employeeId: 'hopegiver', userEmail: 'dev@malgnsoft.com', days: [['2026-09-01', dayValues({ input_tokens: 10 })]] })]
      ])
      const rows = mergeD1AndPromUsers(d1Users, byUnit, new Map())
      expect(rows[0].observed_employee_name).toBeNull()
      expect(rows[0].observed_name_mismatch).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// 공용 워크스테이션 축(docs/design/usage-shared-workstation-axes.md) — "employee_id 라벨이 있으면
// 곧 개인"이라는 가정을 관리자 등록 레지스트리로 뒤집는다. 실측 3건(claude/malgn/public)은
// employee_id·employee_name 라벨이 1인분처럼 찍히지만 여러 명이 쓰는 공용 PC다.
// ---------------------------------------------------------------------------
function sharedRow({ employeeId, label = null, note = null }) {
  return { employee_id: employeeId, label, note, registered_by: null, created_at: '2026-09-08T02:00:00.000Z', updated_at: '2026-09-08T02:00:00.000Z' }
}

function sumTotalTokens(rows) {
  return rows.reduce((acc, r) => acc + r.total_tokens, 0)
}

describe('공용 워크스테이션 축 — 분류·표시·총합 보존', () => {
  const CLAUDE_UNIT_KEY = unitKeyOf('claude', 'ai@malgnsoft.com')
  function claudeByUnit(tokens = 88) {
    return new Map([
      [CLAUDE_UNIT_KEY, unit({ employeeId: 'claude', userEmail: 'ai@malgnsoft.com', names: ['김도형'], days: [['2026-09-01', dayValues({ input_tokens: tokens })]] })]
    ])
  }

  // 완료판정 ⑥ — row_key 계약 잠금. PM 판정1(2026-09-08): 설계 초안의 shr: 재키잉은 채택하지
  // 않는다. row_key는 정렬 tie-break 키이자 프런트 v-for :key 계약값이고, employees.get('emp:'+id)
  // 조회에 묶인 지점이 3곳이다. 나중에 누가 "고치려고" 접두사를 바꾸면 이 테스트가 막는다.
  it('[계약 잠금] 공용으로 등록돼도 row_key는 emp:<id> 그대로다 — shr: 재키잉을 하지 않는다', () => {
    expect(rowKeyOf('claude', 'ai@malgnsoft.com')).toBe('emp:claude')

    const employees = foldToEmployees(claudeByUnit(), new Map([['claude', sharedRow({ employeeId: 'claude' })]]))
    expect([...employees.keys()]).toEqual(['emp:claude'])
    expect(employees.get('emp:claude').identitySource).toBe('shared_workstation')

    const rows = mergeD1AndPromUsers([], claudeByUnit(), new Map([['claude', sharedRow({ employeeId: 'claude' })]]))
    expect(rows[0].row_key).toBe('emp:claude')
  })

  it('레지스트리에 있으면 identity_source가 shared_workstation, 없으면 employee_id다(신규 행 필드·source 값 추가 없음)', () => {
    const notShared = foldToEmployees(claudeByUnit(), new Map()).get('emp:claude')
    expect(notShared.identitySource).toBe('employee_id')
    expect(notShared.isShared).toBe(false)

    const shared = foldToEmployees(claudeByUnit(), new Map([['claude', sharedRow({ employeeId: 'claude', label: '3층 공용 PC' })]])).get('emp:claude')
    expect(shared.identitySource).toBe('shared_workstation')
    expect(shared.isShared).toBe(true)
    expect(shared.sharedLabel).toBe('3층 공용 PC')

    // 공용 행의 source는 여전히 prometheus_only다 — 프런트가 source를 5곳에서 분기하므로 배포 갭
    // 구간에 옛 SPA가 깨지지 않도록 값 자체를 늘리지 않는다(설계 §3.4).
    const rows = mergeD1AndPromUsers([], claudeByUnit(), new Map([['claude', sharedRow({ employeeId: 'claude' })]]))
    expect(rows[0].source).toBe('prometheus_only')
    expect(rows[0].identity_source).toBe('shared_workstation')
  })

  it('sharedById 인자를 빠뜨리면 TypeError — 조용히 "전부 개인"(현행 버그)으로 되돌아가지 않는다(S11)', () => {
    expect(() => foldToEmployees(claudeByUnit())).toThrow(TypeError)
    expect(() => foldToEmployees(claudeByUnit(), null)).toThrow(TypeError)
    expect(() => foldToEmployees(claudeByUnit(), { claude: {} })).toThrow(TypeError) // 평범한 객체도 거부
    expect(() => foldToEmployees(claudeByUnit(), new Map())).not.toThrow() // "비어 있다"는 명시적으로 표현
  })

  // 완료판정 ⑧ — 공용 행 표시 이름. 관측 이름("김도형")을 주 이름으로 쓰면 이번 사고의 원인이
  // 그대로 되살아난다(관리자가 개인 관측치로 오해 → 개인 계정에 연결).
  it('[표시 이름] 공용 행의 name은 라벨(없으면 employee_id)이고 관측 employee_name이 아니다 — 관측 이름은 observed_employee_name에 남는다', () => {
    const withLabel = mergeD1AndPromUsers([], claudeByUnit(), new Map([['claude', sharedRow({ employeeId: 'claude', label: '3층 공용 PC' })]]))
    expect(withLabel[0].name).toBe('3층 공용 PC')
    expect(withLabel[0].name).not.toBe('김도형')
    expect(withLabel[0].observed_employee_name).toBe('김도형') // 정보를 지우지 않는다(표시 우선순위만 바꾼다)

    // S14 — 라벨이 없으면 employee_id로 폴백한다. 관측 이름으로는 절대 폴백하지 않는다.
    const noLabel = mergeD1AndPromUsers([], claudeByUnit(), new Map([['claude', sharedRow({ employeeId: 'claude' })]]))
    expect(noLabel[0].name).toBe('claude')
    expect(noLabel[0].observed_employee_name).toBe('김도형')

    // 등록 전에는 기존 규칙대로 관측 이름이 표시된다(이 변경이 바꾸는 것은 등록된 축뿐이다).
    const unregistered = mergeD1AndPromUsers([], claudeByUnit(), new Map())
    expect(unregistered[0].name).toBe('김도형')
  })

  // 완료판정 ⑦ — 공용 값을 보유한 d1_user 행(직접 DB 조작 등으로만 생기는 모순 상태, S6).
  it('[오귀속 차단] 공용 값을 보유한 회원 행은 사용량 0 + shared_workstation_conflict 경고이고, 공용 행이 별도로 존재한다', () => {
    const d1Users = [{ id: 'u1', email: 'djkim@malgnsoft.com', name: '김덕조', role: 'administrator', status: 'active', employee_id: 'claude' }]
    const rows = mergeD1AndPromUsers(d1Users, claudeByUnit(88), new Map([['claude', sharedRow({ employeeId: 'claude' })]]))

    const userRow = rows.find((r) => r.user_id === 'u1')
    expect(userRow.total_tokens).toBe(0) // 여러 명의 합계가 이 사람 개인 사용량으로 표시되지 않는다
    expect(userRow.group_accounts).toEqual([])
    expect(userRow.identity_source).toBe('shared_workstation')
    expect(userRow.shared_workstation_conflict).toBe(true) // 조용히 0이 되지 않는다 — 이유가 응답에 실린다
    // 이 행은 귀속되는 관측 축이 없으므로(엔트리를 consume하지 않는다) 미연동 회원과 같은
    // d1only: 관례를 쓴다 — emp:claude는 아래 실관측 공용 행이 가져간다(유일성, 아래 전용 테스트).
    expect(userRow.row_key).toBe('d1only:u1')
    expect(userRow.employee_id).toBe('claude') // 잘못 들고 있는 값 자체는 계속 보인다(관리자 진단용)

    const sharedRowOut = rows.find((r) => r.source === 'prometheus_only')
    expect(sharedRowOut).toBeDefined()
    expect(sharedRowOut.employee_id).toBe('claude')
    expect(sharedRowOut.total_tokens).toBe(88) // 값 자체는 사라지지 않는다
    expect(sumTotalTokens(rows)).toBe(88)

    // 대조군: 등록돼 있지 않으면 기존대로 그 회원 행이 관측치를 그대로 흡수한다(=이번에 막는 사고).
    const unregistered = mergeD1AndPromUsers(d1Users, claudeByUnit(88), new Map())
    expect(unregistered.find((r) => r.user_id === 'u1').total_tokens).toBe(88)
    expect(unregistered.find((r) => r.user_id === 'u1').shared_workstation_conflict).toBe(false)
    expect(unregistered.some((r) => r.source === 'prometheus_only')).toBe(false)
  })

  // row_key 유일성 회귀 잠금(docs/api.md §5.9.2 "응답 내 유일 키") — 공용 축을 d1_user 행이
  // consume하지 않게 만들면서 같은 emp:<id>가 두 루프에서 각각 push되는 중복이 생겼던 자리다
  // (프런트 v-for :key가 깨져 한 행만 렌더되는 것으로 실측 발견). 수치를 싣는 공용 관측 행이
  // emp:<id>를 유지하는 것은 비협상이라, 수치 0인 회원 행이 d1only:로 비켜난다.
  describe('[유일성 잠금] row_key는 공용 충돌 상태에서도 응답 내 유일하다', () => {
    function duplicateKeys(rows) {
      const seen = new Set()
      const dups = []
      for (const r of rows) {
        if (seen.has(r.row_key)) dups.push(r.row_key)
        seen.add(r.row_key)
      }
      return dups
    }

    it('공용 값을 보유한 회원 + 그 축의 실관측이 함께 있어도 row_key 중복이 없다(회원 행이 d1only:로 비켜난다)', () => {
      const d1Users = [{ id: 'u1', email: 'djkim@malgnsoft.com', name: '김덕조', role: 'administrator', status: 'active', employee_id: 'claude' }]
      const rows = mergeD1AndPromUsers(d1Users, claudeByUnit(88), new Map([['claude', sharedRow({ employeeId: 'claude' })]]))

      expect(rows).toHaveLength(2) // 두 행이 실제로 모두 존재한다(중복 제거로 한 행을 없애지 않았다)
      expect(duplicateKeys(rows)).toEqual([])
      expect(rows.map((r) => r.row_key).sort()).toEqual(['d1only:u1', 'emp:claude'])
      // 수치를 싣는 쪽이 emp: 계약을 유지한다(비협상) — 0인 쪽이 비켜났다.
      expect(rows.find((r) => r.row_key === 'emp:claude').total_tokens).toBe(88)
      expect(rows.find((r) => r.row_key === 'd1only:u1').total_tokens).toBe(0)
    })

    it('충돌 회원이 여러 명이어도(같은 공용 값을 두 명이 보유) 각자 d1only:<user_id>라 서로도 충돌하지 않는다', () => {
      const d1Users = [
        { id: 'u1', email: 'a@malgnsoft.com', name: 'A', role: 'employee', status: 'active', employee_id: 'claude' },
        { id: 'u2', email: 'b@malgnsoft.com', name: 'B', role: 'employee', status: 'active', employee_id: 'claude' }
      ]
      const rows = mergeD1AndPromUsers(d1Users, claudeByUnit(88), new Map([['claude', sharedRow({ employeeId: 'claude' })]]))
      expect(duplicateKeys(rows)).toEqual([])
      expect(rows.map((r) => r.row_key).sort()).toEqual(['d1only:u1', 'd1only:u2', 'emp:claude'])
      expect(sumTotalTokens(rows)).toBe(88) // 두 명 모두 0 — 88이 두 번 세어지지 않는다
    })

    it('등록 3건 + 미연동/그룹/미식별이 섞인 전체 fixture에서도, 등록 유·무 양쪽 모두 row_key 중복이 0이다', () => {
      const d1Users = [
        { id: 'u1', email: 'hopegiver@malgnsoft.com', name: '하근호', role: 'administrator', status: 'active', employee_id: 'hopegiver' },
        { id: 'u2', email: 'djkim@malgnsoft.com', name: '김덕조', role: 'employee', status: 'active', employee_id: 'malgn' },
        { id: 'u3', email: 'new@malgnsoft.com', name: '신입', role: 'employee', status: 'active', employee_id: null }
      ]
      const byUnit = new Map([
        [unitKeyOf('hopegiver', 'dev@malgnsoft.com'), unit({ employeeId: 'hopegiver', userEmail: 'dev@malgnsoft.com', names: ['하근호'], days: [['2026-09-01', dayValues({ input_tokens: 100 })]] })],
        [unitKeyOf('malgn', 'ai@malgnsoft.com'), unit({ employeeId: 'malgn', userEmail: 'ai@malgnsoft.com', names: ['김덕조'], days: [['2026-09-01', dayValues({ input_tokens: 200 })]] })],
        [unitKeyOf('claude', 'claude@malgnsoft.com'), unit({ employeeId: 'claude', userEmail: 'claude@malgnsoft.com', names: ['김도형'], days: [['2026-09-01', dayValues({ input_tokens: 300 })]] })],
        [unitKeyOf('claude', 'ai@malgnsoft.com'), unit({ employeeId: 'claude', userEmail: 'ai@malgnsoft.com', names: ['김도형'], days: [['2026-09-02', dayValues({ input_tokens: 5 })]] })],
        [unitKeyOf('public', 'public@malgnsoft.com'), unit({ employeeId: 'public', userEmail: 'public@malgnsoft.com', names: ['이진화'], days: [['2026-09-01', dayValues({ input_tokens: 400 })]] })],
        [unitKeyOf(null, 'sales@malgnsoft.com'), unit({ userEmail: 'sales@malgnsoft.com', days: [['2026-09-01', dayValues({ input_tokens: 9 })]] })],
        [unitKeyOf(null, null), unit({ days: [['2026-09-01', dayValues({ input_tokens: 3 })]] })]
      ])
      const registry = new Map([
        ['claude', sharedRow({ employeeId: 'claude' })],
        ['malgn', sharedRow({ employeeId: 'malgn', label: '영업팀 공용 PC' })],
        ['public', sharedRow({ employeeId: 'public' })]
      ])

      expect(duplicateKeys(mergeD1AndPromUsers(d1Users, byUnit, new Map()))).toEqual([])
      const with3 = mergeD1AndPromUsers(d1Users, byUnit, registry)
      expect(duplicateKeys(with3)).toEqual([])
      // 충돌한 u2만 d1only:로 비켜나고, 충돌 없는 u1은 emp: 그대로다(변경이 최소 범위임을 잠근다).
      expect(with3.find((r) => r.user_id === 'u2').row_key).toBe('d1only:u2')
      expect(with3.find((r) => r.user_id === 'u1').row_key).toBe('emp:hopegiver')
      expect(with3.find((r) => r.user_id === 'u3').row_key).toBe('d1only:u3')
    })
  })

  // 완료판정 ⑤ — 총합 보존 회귀 가드. 등록/해제는 귀속만 옮기고 합계를 절대 바꾸지 않는다(§4.4).
  it('[총합 보존] 레지스트리 유/무에 대해 Σ rows.total_tokens가 정확히 동일하다(귀속만 이동한다)', () => {
    const d1Users = [
      { id: 'u1', email: 'hopegiver@malgnsoft.com', name: '하근호', role: 'administrator', status: 'active', employee_id: 'hopegiver' },
      { id: 'u2', email: 'djkim@malgnsoft.com', name: '김덕조', role: 'employee', status: 'active', employee_id: 'malgn' },
      { id: 'u3', email: 'new@malgnsoft.com', name: '신입', role: 'employee', status: 'active', employee_id: null }
    ]
    const byUnit = new Map([
      [unitKeyOf('hopegiver', 'dev@malgnsoft.com'), unit({ employeeId: 'hopegiver', userEmail: 'dev@malgnsoft.com', names: ['하근호'], days: [['2026-09-01', dayValues({ input_tokens: 100, output_tokens: 7 })]] })],
      [unitKeyOf('malgn', 'ai@malgnsoft.com'), unit({ employeeId: 'malgn', userEmail: 'ai@malgnsoft.com', names: ['김덕조'], days: [['2026-09-01', dayValues({ input_tokens: 200, cache_read_tokens: 11 })]] })],
      [unitKeyOf('claude', 'claude@malgnsoft.com'), unit({ employeeId: 'claude', userEmail: 'claude@malgnsoft.com', names: ['김도형'], days: [['2026-09-01', dayValues({ input_tokens: 300 })]] })],
      [unitKeyOf('claude', 'ai@malgnsoft.com'), unit({ employeeId: 'claude', userEmail: 'ai@malgnsoft.com', names: ['김도형'], days: [['2026-09-02', dayValues({ input_tokens: 5 })]] })],
      [unitKeyOf('public', 'public@malgnsoft.com'), unit({ employeeId: 'public', userEmail: 'public@malgnsoft.com', names: ['이진화'], days: [['2026-09-01', dayValues({ input_tokens: 400 })]] })],
      [unitKeyOf(null, 'sales@malgnsoft.com'), unit({ userEmail: 'sales@malgnsoft.com', days: [['2026-09-01', dayValues({ input_tokens: 9 })]] })],
      [unitKeyOf(null, null), unit({ days: [['2026-09-01', dayValues({ input_tokens: 3 })]] })]
    ])
    const registry = new Map([
      ['claude', sharedRow({ employeeId: 'claude' })],
      ['malgn', sharedRow({ employeeId: 'malgn', label: '영업팀 공용 PC' })],
      ['public', sharedRow({ employeeId: 'public' })]
    ])

    const without = mergeD1AndPromUsers(d1Users, byUnit, new Map())
    const with3 = mergeD1AndPromUsers(d1Users, byUnit, registry)

    const expected = 100 + 7 + 200 + 11 + 300 + 5 + 400 + 9 + 3
    expect(sumTotalTokens(without)).toBe(expected)
    expect(sumTotalTokens(with3)).toBe(expected) // 어떤 등록/해제 조작으로도 총합은 변하지 않는다

    // 귀속만 이동했다 — 'malgn'을 보유한 u2 행이 0이 되고 그만큼이 공용 행으로 옮겨간다.
    expect(without.find((r) => r.user_id === 'u2').total_tokens).toBe(211)
    expect(with3.find((r) => r.user_id === 'u2').total_tokens).toBe(0)
    expect(with3.find((r) => r.row_key === 'emp:malgn' && r.source === 'prometheus_only').total_tokens).toBe(211)
    // 공용 축 하나당 1행 — 서로 다른 공용 employee_id를 하나로 합치지 않는다(§4.4).
    expect(with3.filter((r) => r.identity_source === 'shared_workstation' && r.source === 'prometheus_only')).toHaveLength(3)
    // claude는 user_email 2개에 걸쳐도 1행 + group_accounts 2건이다(S12).
    const claudeRow = with3.find((r) => r.row_key === 'emp:claude')
    expect(claudeRow.total_tokens).toBe(305)
    expect(claudeRow.group_accounts).toHaveLength(2)
  })

  describe('observed_name_matches_user — 발견 장치(§4.6, 분류에는 일절 관여하지 않는다)', () => {
    const djkim = { id: 'u1', email: 'djkim@malgnsoft.com', name: '김덕조', role: 'employee', status: 'active', employee_id: 'djkim' }
    function malgnByUnit(name = '김덕조') {
      return new Map([
        [unitKeyOf('malgn', 'ai@malgnsoft.com'), unit({ employeeId: 'malgn', userEmail: 'ai@malgnsoft.com', names: [name], days: [['2026-09-01', dayValues({ input_tokens: 10 })]] })]
      ])
    }

    it('관측 이름과 같은 이름의 회원이 정확히 1명이고 그 회원이 다른 축에 연결돼 있으면 채워진다(실측: malgn↔김덕조/djkim)', () => {
      const rows = mergeD1AndPromUsers([djkim], malgnByUnit(), new Map())
      const promOnly = rows.find((r) => r.source === 'prometheus_only')
      expect(promOnly.observed_name_matches_user).toEqual({ user_id: 'u1', email: 'djkim@malgnsoft.com', employee_id: 'djkim' })
    })

    it('동명이인이 2명이면 null — 사람을 지목할 수 없으면 지목하지 않는다(오탐 0 원칙)', () => {
      const twin = { id: 'u2', email: 'djkim2@malgnsoft.com', name: '김덕조', role: 'employee', status: 'active', employee_id: 'djkim2' }
      const rows = mergeD1AndPromUsers([djkim, twin], malgnByUnit(), new Map())
      expect(rows.find((r) => r.source === 'prometheus_only').observed_name_matches_user).toBeNull()
    })

    it('이미 공용으로 등록된 행에서는 채우지 않는다(결론이 난 축이라 경고가 노이즈다)', () => {
      const rows = mergeD1AndPromUsers([djkim], malgnByUnit(), new Map([['malgn', sharedRow({ employeeId: 'malgn' })]]))
      expect(rows.find((r) => r.source === 'prometheus_only').observed_name_matches_user).toBeNull()
    })

    it('일치하는 회원이 없거나(claude↔김도형) d1_user 행이면 null', () => {
      const rows = mergeD1AndPromUsers([djkim], claudeByUnit(), new Map())
      expect(rows.find((r) => r.source === 'prometheus_only').observed_name_matches_user).toBeNull()
      expect(rows.find((r) => r.user_id === 'u1').observed_name_matches_user).toBeNull()
    })
  })
})

describe('daySummaryRows(byUnit) — /summary는 직원 축으로 접지 않고 unit을 그대로 합산해도 결과가 같다(§7.2)', () => {
  it('같은 날짜의 서로 다른 employee_id/user_email unit 값이 day_at별로 정확히 합산된다', () => {
    const byUnit = new Map([
      [unitKeyOf('a', 'x@malgnsoft.com'), unit({ employeeId: 'a', userEmail: 'x@malgnsoft.com', days: [['2026-09-01', dayValues({ input_tokens: 10 })]] })],
      [unitKeyOf('b', 'x@malgnsoft.com'), unit({ employeeId: 'b', userEmail: 'x@malgnsoft.com', days: [['2026-09-01', dayValues({ input_tokens: 20 })]] })]
    ])
    const rows = daySummaryRows(byUnit)
    expect(rows).toHaveLength(1)
    expect(rows[0].day_at).toBe('2026-09-01')
    expect(rows[0].input_tokens).toBe(30)
  })
})

describe('zeroTotals — export 확인(라우트가 identity_unlinked/invalid 빈 응답에 재사용)', () => {
  it('전 필드가 0/null인 총계를 반환한다', () => {
    expect(zeroTotals()).toEqual({
      session_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
      total_tokens: 0, cost_usd: 0, active_days: 0, last_active_day: null
    })
  })
})

describe('getUsageOverviewHybrid — requireEmployeeScope 안전망(usage-employee-identity-linking.md §4.2 I7)', () => {
  // env를 절대 건드리면 안 되는 경로임을 증명하기 위해 접근 시 즉시 예외를 던지는 미끼 객체를 쓴다 —
  // 가드가 실제로 D1/상류를 건드리지 않고 조기 반환하는지 이 방식으로 확실히 검증한다.
  const poisonedEnv = new Proxy({}, {
    get() { throw new Error('getUsageOverviewHybrid touched env despite requireEmployeeScope guard') }
  })

  it('requireEmployeeScope:true인데 employeeId가 없으면(scoped:false) env를 전혀 건드리지 않고 빈 스냅샷을 즉시 반환한다', async () => {
    const result = await getUsageOverviewHybrid(poisonedEnv, {
      from: '2026-08-01', to: '2026-08-05', refresh: false, employeeId: null, requireEmployeeScope: true
    })
    expect(result.byUnit.size).toBe(0)
    expect(result.gapDays).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'])
    expect(result.segments).toEqual({ cached: null, live: null })
    expect(result.liveUnavailable).toBe(false)
    expect(result.dataStart).toBeNull()
  })

  it('requireEmployeeScope:true인데 employeeId가 빈 문자열이어도(scoped:false와 동일) 조기 반환한다', async () => {
    const result = await getUsageOverviewHybrid(poisonedEnv, {
      from: '2026-08-01', to: '2026-08-01', refresh: false, employeeId: '', requireEmployeeScope: true
    })
    expect(result.byUnit.size).toBe(0)
  })
})

describe('getUsageOverviewHybrid — M-3 회귀(리뷰 2026-09-07): 스코프 조회는 레거시(identity_version 불일치) 날짜를 "확정 0"이 아니라 gap으로 보고한다', () => {
  // KST 전환(usage-kst-day-boundary.md §3) 이후 NORM_VERSION이 'v1'→'v2'로 승격됐다 — 이 테스트가
  // 검증하려는 것은 identity_version 판정(§9.1)이지 norm_version 승격 자체가 아니므로, 실제
  // getUsageOverviewHybrid가 보는 것과 항상 같은 값이 되도록 하드코딩 대신 정본 상수를 그대로 쓴다.
  const HYBRID_AGG_MODE = AGG_MODE
  const HYBRID_NORM_VERSION = NORM_VERSION

  // readHybridSnapshot(server/dao/usage-prom-daily.js)의 db.batch() 응답 4개를 그대로 흉내낸다 —
  // stmts 내용은 보지 않고 고정 응답을 순서대로 돌려준다(SQL 자체는 DAO 계층 책임, 여기는
  // getUsageOverviewHybrid의 coveredDays/gapDays 판정 로직만 검증).
  // sharedRows — usage_shared_workstations 전건 조회(server/dao/usage-shared-workstations.js
  // listAll)는 bind 없이 곧바로 .all()을 부른다. getUsageOverviewHybrid가 이 조회를
  // readHybridSnapshot과 병렬로 수행하므로 목이 .all()을 제공하지 않으면 요청 전체가 실패한다
  // (fail-closed가 실제로 작동한다는 방증이기도 하다).
  function fakeEnv({ validRows, coverageInRange, allCoverage, overall, sharedRows = [] }) {
    return {
      DB: {
        prepare() { return { bind: () => ({}), all: async () => ({ results: sharedRows }) } },
        async batch() {
          return [{ results: validRows }, { results: coverageInRange }, { results: allCoverage }, { results: [overall] }]
        }
      }
    }
  }

  // 2026-08-01 = 레거시(migrations/0019가 이전한 employee_id='' 행, identity_version='v0').
  // 2026-08-02 = 재적재 완료(identity_version='v1'). 둘 다 agg_mode/norm_version은 현재값과 일치 —
  // "값은 맞지만 축이 옛것"인 상태를 재현한다.
  const coverageFixture = [
    { day_at: '2026-08-01', agg_mode: HYBRID_AGG_MODE, norm_version: HYBRID_NORM_VERSION, identity_version: 'v0', user_rows: 1, unknown_types_json: null, fetched_at: '2026-08-02T00:00:00.000Z' },
    { day_at: '2026-08-02', agg_mode: HYBRID_AGG_MODE, norm_version: HYBRID_NORM_VERSION, identity_version: 'v1', user_rows: 1, unknown_types_json: null, fetched_at: '2026-08-03T00:00:00.000Z' }
  ]
  const allCoverageFixture = coverageFixture.map(({ day_at, agg_mode, norm_version }) => ({ day_at, agg_mode, norm_version }))

  it('스코프 조회(employeeId 지정, /me)에서는 v0 날짜가 gap_days에 들어가고 byUnit에도 그 날짜가 나타나지 않는다', async () => {
    // 실제 D1의 SQL 파라미터 필터(d.employee_id=?5)를 흉내: 레거시 행(employee_id='')은 스코프
    // 조회에서 이미 제외되므로 validRows에는 v1 날짜(2026-08-02)의 본인 행만 존재한다.
    const env = fakeEnv({
      validRows: [
        { day_at: '2026-08-02', employee_id: 'self', user_email: 'self@malgnsoft.com', employee_name: null, session_count: 1, input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 }
      ],
      coverageInRange: coverageFixture,
      allCoverage: allCoverageFixture,
      overall: { data_start: '2026-08-01', last_sync_at: '2026-08-03T00:00:00.000Z' }
    })

    const result = await getUsageOverviewHybrid(env, {
      from: '2026-08-01', to: '2026-08-02', refresh: false, employeeId: 'self', requireEmployeeScope: true
    })

    expect(result.gapDays).toEqual(['2026-08-01']) // "확정 0"이 아니라 결손으로 정직하게 보고
    const entry = result.byUnit.get(unitKeyOf('self', 'self@malgnsoft.com'))
    expect(entry.days.has('2026-08-01')).toBe(false)
    expect(entry.days.has('2026-08-02')).toBe(true)
  })

  it('비스코프 조회(/summary·/users, employeeId 생략)에서는 같은 v0 날짜가 여전히 covered로 남아 총합 보존이 깨지지 않는다(architecture.md §0 결정30)', async () => {
    const env = fakeEnv({
      validRows: [
        { day_at: '2026-08-01', employee_id: '', user_email: 'group@malgnsoft.com', employee_name: null, session_count: 1, input_tokens: 50, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 },
        { day_at: '2026-08-02', employee_id: 'self', user_email: 'self@malgnsoft.com', employee_name: null, session_count: 1, input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 }
      ],
      coverageInRange: coverageFixture,
      allCoverage: allCoverageFixture,
      overall: { data_start: '2026-08-01', last_sync_at: '2026-08-03T00:00:00.000Z' }
    })

    const result = await getUsageOverviewHybrid(env, { from: '2026-08-01', to: '2026-08-02', refresh: false })

    expect(result.gapDays).toEqual([])
    const legacyEntry = result.byUnit.get(unitKeyOf(null, 'group@malgnsoft.com'))
    expect(legacyEntry.days.has('2026-08-01')).toBe(true)
  })
})
