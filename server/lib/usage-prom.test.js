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
  resolveEmailScope
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

describe('resolveEmailScope — GET /api/usage/me 본인 스코프 판정(승인결정1, IDOR 방지)', () => {
  it('email 없으면(관리자 전사 조회, /summary·/users 기존 호출부) 완전 무필터', () => {
    expect(resolveEmailScope(undefined)).toEqual({ scoped: false, emailSafe: false, emailLower: null, matchers: [] })
  })

  it('안전한 이메일은 소문자 emailLower + user_email 라벨매처 1개를 만든다', () => {
    const scope = resolveEmailScope('Dev@Malgnsoft.com')
    expect(scope.scoped).toBe(true)
    expect(scope.emailSafe).toBe(true)
    expect(scope.emailLower).toBe('dev@malgnsoft.com')
    expect(scope.matchers).toEqual(['user_email="Dev@Malgnsoft.com"'])
  })

  it('라벨 인젝션 위험 문자가 섞인 이메일은 matchers를 비우되(라이브 질의 생략용) scoped는 유지한다 — ' +
      '빈 matchers가 "무필터(전사)"로 오독되면 안 되므로 scoped 플래그로 두 상태를 구분한다', () => {
    const scope = resolveEmailScope('a"@malgnsoft.com')
    expect(scope.scoped).toBe(true)
    expect(scope.emailSafe).toBe(false)
    expect(scope.matchers).toEqual([])
    // D1 캐시 스코핑(emailLower)은 라벨 안전성과 무관하게 항상 유효해야 한다 — SQL 파라미터라 인젝션 불가.
    expect(scope.emailLower).toBe('a"@malgnsoft.com')
  })
})
