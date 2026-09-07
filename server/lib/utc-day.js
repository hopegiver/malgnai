// UTC 일(day) 계산 정본(m-2 수정, 리뷰 2026-09-03) — server/lib/usage-prom.js, server/lib/usage-rollup.js,
// server/api/usage.js 세 곳이 각자 todayUTCString()/addDaysUTC()를 독립적으로 복제하고 있었다. 값
// 자체는 세 구현이 항상 동일함을 리뷰에서 대조 확인했지만, 복제본 중 하나(usage-rollup.js)가 하필
// W1 불변식(Cron이 오늘을 롤업 대상에서 빼는 경계)을 판정하는 데 쓰여 향후 어느 한쪽만 고치면
// 이음매가 조용히 갈라질 위험이 있었다. 이 파일 하나로 합친다 — UTC 일 계산이 필요한 곳은 항상
// 이 두 함수를 쓰고, 새로 복제하지 않는다.
//
// server/lib/usage-prom.js의 dayGridWindow 등 "밀리초 단위 그리드 경계" 계산은 이 파일이 다루는
// 범위가 아니다(Prometheus 질의 전용 세부 로직이라 usage-prom.js에 남는다) — 이 파일은 순수하게
// "YYYY-MM-DD 문자열 하나를 며칠 앞뒤로 옮기거나 오늘 날짜를 구하는" 두 연산만 담는다.

/** nowMs(기본 Date.now())가 속한 UTC 날짜를 'YYYY-MM-DD'로 반환. */
export function todayUTCString(nowMs = Date.now()) {
  const d = new Date(nowMs)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10)
}

/** 'YYYY-MM-DD' 문자열을 UTC 기준 days일만큼 이동(음수 가능)한 'YYYY-MM-DD'를 반환. */
export function addDaysUTC(dayAt, days) {
  const d = new Date(`${dayAt}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
