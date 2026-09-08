// day-boundary.js 단위테스트(docs/design/usage-kst-day-boundary.md §10-A, §8) — KST 전환의 정의
// 그 자체(§10-A2 "UTC 15:00 전후가 다른 날에 들어간다")와 고정 오프셋(+9h, DST 없음) 가정을
// Intl.DateTimeFormat과 대조해 검증한다. 순수 함수만 대상 — D1/네트워크 의존 없음.
import { describe, it, expect } from 'vitest'
import { DAY_TZ, DAY_OFFSET_MINUTES, todayDayAt, dayAtOfMs, dayStartMs, addDays } from './day-boundary.js'

describe('상수 — DAY_TZ/DAY_OFFSET_MINUTES가 KST 고정 오프셋을 명시한다(설계 §8)', () => {
  it('DAY_TZ는 Asia/Seoul, DAY_OFFSET_MINUTES는 540(UTC+9)이다', () => {
    expect(DAY_TZ).toBe('Asia/Seoul')
    expect(DAY_OFFSET_MINUTES).toBe(540)
  })
})

describe('todayDayAt/dayAtOfMs — KST 자정 경계(설계 §10-A1~A4)', () => {
  it('UTC 15:00:00 1초 전은 그 날짜(KST 기준 아직 전날)로 매핑된다', () => {
    expect(todayDayAt(Date.parse('2026-09-08T14:59:59Z'))).toBe('2026-09-08')
  })

  it('UTC 15:00:00 정각은 다음 날짜로 넘어간다 — 이 전환의 정의 그 자체', () => {
    expect(todayDayAt(Date.parse('2026-09-08T15:00:00Z'))).toBe('2026-09-09')
  })

  it('KST 자정(예: 2026-09-09T00:00:00+09:00)은 그 날에 속한다(경계 포함 방향 고정)', () => {
    expect(dayAtOfMs(Date.parse('2026-09-09T00:00:00+09:00'))).toBe('2026-09-09')
  })

  it('월 롤오버 — 2026-08-31T15:00:00Z는 2026-09-01로 넘어간다', () => {
    expect(dayAtOfMs(Date.parse('2026-08-31T15:00:00Z'))).toBe('2026-09-01')
  })

  it('연 롤오버 — 2026-12-31T15:00:00Z는 2027-01-01로 넘어간다', () => {
    expect(dayAtOfMs(Date.parse('2026-12-31T15:00:00Z'))).toBe('2027-01-01')
  })
})

describe('dayStartMs — KST 날짜 라벨이 시작하는 epoch(설계 §10-A3)', () => {
  it("dayStartMs('2026-09-09')는 2026-09-08T15:00:00Z와 정확히 같다", () => {
    expect(dayStartMs('2026-09-09')).toBe(Date.parse('2026-09-08T15:00:00Z'))
  })

  it('dayStartMs(d)로 되돌린 epoch를 다시 dayAtOfMs에 넣으면 그 날짜 d로 돌아온다(왕복 일관성)', () => {
    const d = '2026-03-15'
    expect(dayAtOfMs(dayStartMs(d))).toBe(d)
  })
})

describe('addDays — 라벨 산술은 시간대와 무관하다(설계 §10-A6, §1-b)', () => {
  it("addDays('2026-03-01', -1) === '2026-02-28'(평년 2월 롤오버)", () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('연 경계를 넘는 이동도 정확하다', () => {
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('KST 00~09시(=UTC 전날 15~24시) — todayDayAt이 UTC 날짜와 갈리는 구간(설계 §10-B9, §4)', () => {
  it('UTC 2026-09-08T20:00:00Z(=KST 2026-09-09T05:00) 시각의 todayDayAt은 UTC 날짜(09-08)가 아니라 KST 날짜(09-09)다', () => {
    const nowMs = Date.parse('2026-09-08T20:00:00Z')
    expect(todayDayAt(nowMs)).toBe('2026-09-09')
    // 회귀 방지 — UTC 계산이 남아 있으면 이 값이 '2026-09-08'로 잘못 나온다.
    expect(todayDayAt(nowMs)).not.toBe(new Date(nowMs).toISOString().slice(0, 10))
  })
})

describe('DST 없음 / 고정 +9 가정 검증(설계 §8, §10-A11) — Intl.DateTimeFormat과 대조', () => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' })

  // 20개 표본 — 하루 경계 부근, 월/연 롤오버, 임의 시각을 섞는다.
  const samples = [
    '2026-01-01T00:00:00Z', '2026-01-01T14:59:59Z', '2026-01-01T15:00:00Z',
    '2026-02-28T15:00:00Z', '2026-03-01T00:00:00Z',
    '2026-04-15T03:23:11Z', '2026-05-20T12:00:00Z', '2026-06-30T23:59:59Z',
    '2026-07-04T15:00:00Z', '2026-08-15T14:59:59Z', '2026-08-31T15:00:00Z',
    '2026-09-08T00:00:00Z', '2026-09-08T14:59:59Z', '2026-09-08T15:00:00Z',
    '2026-10-31T15:00:00Z', '2026-11-01T00:00:00Z', '2026-12-24T15:00:00Z',
    '2026-12-31T14:59:59Z', '2026-12-31T15:00:00Z', '2027-01-01T09:00:00Z'
  ]

  it.each(samples)('%s — 고정 오프셋 결과와 Intl.DateTimeFormat(Asia/Seoul) 결과가 일치한다', (iso) => {
    const ms = Date.parse(iso)
    expect(dayAtOfMs(ms)).toBe(fmt.format(new Date(ms)))
  })
})
