/**
 * 로그인 브루트포스 방어 — 인메모리 실패 카운터(단일 상시 Node 프로세스 전제, DB 불필요).
 * username(대소문자 무시) 기준: WINDOW_MS 내 MAX_ATTEMPTS 회 실패 시 LOCKOUT_MS 동안 잠금.
 * 존재하지 않는 사용자명도 동일하게 카운트되어 계정 존재 여부 열거(enumeration)도 함께 막는다.
 */
const MAX_ATTEMPTS = 5
const WINDOW_MS = 15 * 60 * 1000
const LOCKOUT_MS = 15 * 60 * 1000

const attempts = new Map()

const keyOf = (username) => String(username || '').trim().toLowerCase()

export function checkLoginThrottle(username) {
  const key = keyOf(username)
  const entry = attempts.get(key)
  if (!entry) return { locked: false }

  const now = Date.now()
  if (entry.lockedUntil) {
    if (now < entry.lockedUntil) {
      return { locked: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) }
    }
    attempts.delete(key)
  }
  return { locked: false }
}

export function recordLoginFailure(username) {
  const key = keyOf(username)
  const now = Date.now()
  const entry = attempts.get(key)

  if (!entry || now - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now, lockedUntil: null })
    return
  }

  entry.count += 1
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS
  }
}

export function recordLoginSuccess(username) {
  attempts.delete(keyOf(username))
}
