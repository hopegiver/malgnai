// 사용량 통계 "하루" 경계 계산 정본(KST 전환, docs/design/usage-kst-day-boundary.md §2 Q1 C안) —
// server/lib/usage-prom.js, server/lib/usage-rollup.js, server/api/usage.js 세 곳이 쓰는 day_at
// 버킷 정의가 전부 이 파일 하나에서 나온다. 이전에 UTC 자정 경계를 계산하던 옛 정본 모듈은
// 삭제됐다 — re-export shim을 두지 않은 이유는 "UTC 전용을 뜻하던 옛 함수 이름"이 KST 값을
// 반환하는 상태를 영구화하지 않기 위해서다(설계 §2 Q1 D안 기각 사유). 이 코드베이스는 예전에
// "일 계산 정본이 세 파일에 복제돼 있다가 한쪽만 고쳐 W1 불변식 판정이 갈릴 뻔한" 사고를 이미
// 겪었다(설계 §2 Q1 B안 기각 사유가 그 사고를 인용한다) — 이번에도 같은 실패를 반복하지 않으려면
// **오프셋 상수(+9h/54000)를 이 파일 밖에서 절대 다시 쓰지 않는다.** 새로 KST 경계가 필요한 곳은
// 항상 이 파일의 함수를 가져다 쓰고, 자정 앵커 문자열이나 오프셋 상수를 직접 조립하지 않는다.
//
// KST(Asia/Seoul)는 1961년 이후 서머타임 없는 고정 UTC+9다(설계 §8) — 순수 산술로 충분하고
// `Intl.DateTimeFormat`/ICU에 기대지 않는다(Workers 런타임의 로케일 데이터에 결과가 종속되는 것을
// 피한다). 이 가정은 server/lib/day-boundary.test.js의 "Intl.DateTimeFormat과 대조" 테스트로
// 별도 검증한다.
//
// 함수 이름은 중립(KST를 박지 않음)이다 — 호출부의 관심사는 "day_at의 오늘"이지 "서울의 오늘"이
// 아니고, 정책이 바뀌어도 호출부가 다시 개명 대상이 되지 않게 한다. 오독 방지는 이름 대신 아래
// export 상수와 주석이 담당한다.

/** day_at 버킷이 따르는 시간대 — 표시·문서화용 상수(계산 자체는 DAY_OFFSET_MINUTES 산술로 한다). */
export const DAY_TZ = 'Asia/Seoul'

/** KST = UTC+9, 고정(서머타임 없음, 설계 §8). day_at 경계 산술이 쓰는 유일한 오프셋 정본 —
 *  다른 파일은 이 상수를 참조하지 않고 `+9`·`54000`·`T00:00:00Z`를 직접 조립하지 않는다. */
export const DAY_OFFSET_MINUTES = 540

const DAY_OFFSET_MS = DAY_OFFSET_MINUTES * 60000
const DAY_MS = 86400000

/** 임의 epoch(ms)가 속한 KST 날짜를 'YYYY-MM-DD'로 반환. KST 자정(예: 2026-09-09T00:00:00+09:00,
 *  = 2026-09-08T15:00:00Z)은 그 날에 속한다(경계 포함 방향, 설계 §10-A4). */
export function dayAtOfMs(ms) {
  return new Date(ms + DAY_OFFSET_MS).toISOString().slice(0, 10)
}

/** nowMs(기본 Date.now())가 속한 KST 날짜를 'YYYY-MM-DD'로 반환. */
export function todayDayAt(nowMs = Date.now()) {
  return dayAtOfMs(nowMs)
}

/** 'YYYY-MM-DD'(KST 날짜 라벨)이 시작하는 순간의 epoch(ms) — 그 날 KST 00:00 = 전날 UTC 15:00. */
export function dayStartMs(dayAt) {
  return Date.parse(`${dayAt}T00:00:00Z`) - DAY_OFFSET_MS
}

/** 'YYYY-MM-DD' 문자열을 days일만큼 이동(음수 가능)한 'YYYY-MM-DD'를 반환 — 순수 라벨 산술이라
 *  시간대와 무관하다(설계 §1-b, §10-A6). */
export function addDays(dayAt, days) {
  const d = new Date(`${dayAt}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// day-boundary 계산 안에서만 쓰는 하루 길이 상수 — 호출부(usage-prom.js 등)는 그리드 간격 계산에
// 이 값을 계속 쓰지만(월력 무관 고정 86400000ms), 일 경계 자체는 위 함수들이 전담한다.
export { DAY_MS }
