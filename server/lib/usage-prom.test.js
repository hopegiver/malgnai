// M-5 최소 단위테스트(리뷰 2026-09-03, review-usage-prometheus-hybrid-2026-09-03.md) — 이 변경의
// 핵심 불변식(이음매 W1/W2, off-by-one, gap_days 정직성, PromQL 인젝션 방지)은 이전에 전부 정적
// 추론으로만 검증돼 있었다. 외부 네트워크·D1 의존 없이 도는 순수 함수만 대상으로 한다(통합/E2E는
// 이번 범위 밖 — PM 지시).
import { describe, it, expect } from 'vitest'
import {
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
  getUsageOverviewHybrid
} from './usage-prom.js'

const NOW = Date.parse('2026-09-03T10:00:00Z') // 화요일, 오늘=2026-09-03(UTC) 고정

describe('promTimestampToDayAt — off-by-one 매핑(설계 §4.2)', () => {
  it('버킷 정각(자정)은 그 전날로 매핑된다', () => {
    const t = Date.parse('2026-09-03T00:00:00Z') / 1000
    expect(promTimestampToDayAt(t)).toBe('2026-09-02')
  })

  it('버킷 마지막 초(다음날 자정 1초 전)도 같은 전날로 매핑된다 — 하루 안에서 결과가 흔들리지 않는다', () => {
    const t = Date.parse('2026-09-03T23:59:59Z') / 1000
    expect(promTimestampToDayAt(t)).toBe('2026-09-02')
  })

  it('자정을 한 틱 넘기면(다음날 00:00:00) 매핑도 정확히 하루만 밀린다', () => {
    const before = Date.parse('2026-09-03T23:59:59Z') / 1000
    const after = Date.parse('2026-09-04T00:00:00Z') / 1000
    expect(promTimestampToDayAt(before)).toBe('2026-09-02')
    expect(promTimestampToDayAt(after)).toBe('2026-09-03')
  })
})

describe('dayGridWindow — 완결일 그리드 경계(설계 §4.2·§4.3)', () => {
  it('from=to=오늘이면 완결된 버킷이 없어 null(오늘분은 별도 instant 질의로 얹는다)', () => {
    expect(dayGridWindow('2026-09-03', '2026-09-03', NOW)).toBeNull()
  })

  it('to가 오늘이면(to+1일이 오늘을 넘으므로) end가 "오늘 00:00Z"로 클램프된다', () => {
    const grid = dayGridWindow('2026-08-30', '2026-09-03', NOW)
    const todayStartSec = Date.parse('2026-09-03T00:00:00Z') / 1000
    expect(grid.end).toBe(todayStartSec)
  })

  it('완전한 과거 구간은 start/end가 정확히 하루(+1일) 밀려서 계산된다', () => {
    const grid = dayGridWindow('2026-08-01', '2026-08-07', NOW)
    expect(grid.start).toBe(Date.parse('2026-08-02T00:00:00Z') / 1000)
    expect(grid.end).toBe(Date.parse('2026-08-08T00:00:00Z') / 1000)
    expect(grid.step).toBe(86400)
  })
})

describe('todayPartialWindow — 오늘 부분일 경계(설계 §4.3, M-2 TTL 버킷팅)', () => {
  it('to가 오늘보다 과거면 질의 자체를 생략(null)', () => {
    expect(todayPartialWindow('2026-09-02', NOW)).toBeNull()
  })

  it('to가 오늘이면 60초 버킷으로 내림된 time/rangeSeconds를 반환', () => {
    const win = todayPartialWindow('2026-09-03', NOW)
    expect(win).not.toBeNull()
    // NOW=10:00:00Z는 이미 60초 배수라 버킷 경계와 정확히 일치한다.
    expect(win.time).toBe(Math.floor(NOW / 1000))
    expect(win.rangeSeconds).toBe(10 * 3600) // 자정부터 10:00:00까지
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
    const employees = foldToEmployees(byUnit)
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
    const employees = foldToEmployees(byUnit)
    const emp = employees.get('grp:public@malgnsoft.com')
    expect(emp).toBeDefined()
    expect(emp.identitySource).toBe('group_account')
    expect(emp.days.get('2026-09-01').input_tokens).toBe(50)
  })

  it('employee_id·user_email 둘 다 없는 관측치는 unk: 단일 행으로 모인다(N2, 최대 1행)', () => {
    const byUnit = new Map([
      [unitKeyOf(null, null), unit({ days: [['2026-09-01', dayValues({ input_tokens: 7 })]] })]
    ])
    const employees = foldToEmployees(byUnit)
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
    const rows = mergeD1AndPromUsers(d1Users, byUnit)
    expect(rows).toHaveLength(1)
    expect(rows[0].row_key).toBe('emp:malgn')
    expect(rows[0].employee_id).toBe('malgn')
    expect(rows[0].total_tokens).toBe(42)
  })

  it('employee_id가 NULL(미연동)인 D1 사용자는 d1only: 행으로 사용량 0으로 뜬다(§7.1 신규 추가 행)', () => {
    const d1Users = [{ id: 'u1', email: 'djkim@malgnsoft.com', name: '김덕조', role: 'administrator', status: 'active', employee_id: null }]
    const rows = mergeD1AndPromUsers(d1Users, new Map())
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
    const rows = mergeD1AndPromUsers(d1Users, byUnit)
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
    const rows = mergeD1AndPromUsers(d1Users, byUnit)
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
      const rows = mergeD1AndPromUsers(d1Users, byUnit)
      expect(rows[0].observed_employee_name).toBe('이진화')
      expect(rows[0].observed_name_mismatch).toBe(true)
    })

    it('관측 이름이 D1 이름과 같으면 mismatch:false', () => {
      const d1Users = [{ id: 'u1', email: 'hopegiver@malgnsoft.com', name: '하근호', role: 'employee', status: 'active', employee_id: 'hopegiver' }]
      const byUnit = new Map([
        [unitKeyOf('hopegiver', 'dev@malgnsoft.com'), unit({ employeeId: 'hopegiver', userEmail: 'dev@malgnsoft.com', names: ['하근호'], days: [['2026-09-01', dayValues({ input_tokens: 10 })]] })]
      ])
      const rows = mergeD1AndPromUsers(d1Users, byUnit)
      expect(rows[0].observed_name_mismatch).toBe(false)
    })

    it('관측 이름이 없으면(employee_name 라벨 없음) observed_employee_name:null, mismatch:false', () => {
      const d1Users = [{ id: 'u1', email: 'hopegiver@malgnsoft.com', name: '하근호', role: 'employee', status: 'active', employee_id: 'hopegiver' }]
      const byUnit = new Map([
        [unitKeyOf('hopegiver', 'dev@malgnsoft.com'), unit({ employeeId: 'hopegiver', userEmail: 'dev@malgnsoft.com', days: [['2026-09-01', dayValues({ input_tokens: 10 })]] })]
      ])
      const rows = mergeD1AndPromUsers(d1Users, byUnit)
      expect(rows[0].observed_employee_name).toBeNull()
      expect(rows[0].observed_name_mismatch).toBe(false)
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
