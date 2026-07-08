/**
 * cadence.js — 자율 사이클 주기 계산 헬퍼(순수 함수, 서버/러너 공유).
 *
 * 배경: 과거 `bin/run-scheduled-jobs.js` 안에만 있던 날짜/주기 키 계산을 서버로 끌어올린다.
 *   분산 전환(설계 §2.4)에서 스폰 결정(due 판정 + next_run_at 갱신 + 멱등키)이 **서버 단일
 *   트랜잭션**으로 옮겨지므로, 러너와 서버가 동일 로직을 공유해야 주기 드리프트가 없다.
 *
 * 여기 함수는 전부 순수(부수효과 없음). `Date` 입력은 로컬 시간 기준으로 키를 만든다
 *   (기존 run-scheduled-jobs.js 거동 100% 보존 — 이동일 뿐 로직 변경 없음).
 */

// --- 날짜 키 헬퍼 (로컬 시간 기준) ---
export function dateKey(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ISO 8601 주차(월요일 시작). 주간 잡의 멱등키.
export function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7 // 일=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum) // 그 주 목요일로 이동
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

// 시(hour) 단위 멱등키(hourly cadence 프로젝트용). 'YYYY-MM-DDTHH'.
export function hourKey(d) {
  return `${dateKey(d)}T${String(d.getHours()).padStart(2, '0')}`
}

// cadence 별 주기 키 — 자율 사이클 멱등키의 시간 구성요소. off/미지정은 null(사이클 생성 스킵).
export function periodKeyForCadence(cadence, now) {
  const c = (cadence || 'daily').toLowerCase()
  if (c === 'off') return null
  if (c === 'hourly') return hourKey(now)
  if (c === 'weekly') return isoWeekKey(now)
  return dateKey(now) // daily(기본)
}

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * cadenceInterval — cadence 문자열 → 다음 due 까지의 간격(ms).
 *   hourly=+1h, daily=+1d, weekly=+7d, 그 외/미지정=daily(+1d).
 *   (periodKey 는 멱등 보조, next_run_at = now + 이 간격 = due 게이트. 두 겹 방어.)
 * @param {string} cadence
 * @returns {number} 간격(밀리초)
 */
export function cadenceInterval(cadence) {
  const c = (cadence || 'daily').toLowerCase()
  if (c === 'hourly') return HOUR_MS
  if (c === 'weekly') return 7 * DAY_MS
  return DAY_MS // daily(기본)
}

/**
 * nextRunAtIso — now(Date) + cadenceInterval 을 ISO8601 문자열로. next_run_at 원자 갱신용.
 * @param {string} cadence
 * @param {Date} now
 * @returns {string} ISO8601
 */
export function nextRunAtIso(cadence, now) {
  return new Date(now.getTime() + cadenceInterval(cadence)).toISOString()
}
