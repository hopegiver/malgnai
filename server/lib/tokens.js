// 인증 토큰 유틸 — 비밀번호 해시(Web Crypto PBKDF2), opaque 토큰(refresh/device), JWT(jose).
// Cloudflare Workers 런타임에서 동작해야 하므로 Node 전용 라이브러리(bcrypt 등)는 쓰지 않는다
// (COO 지시 §4 — 대신 Web Crypto `crypto.subtle` 기반으로 구현).
import { SignJWT, jwtVerify } from 'jose'

// ---------------------------------------------------------------------------
// 비밀번호 해시 (PBKDF2-SHA256, Web Crypto)
// ---------------------------------------------------------------------------
const PBKDF2_ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_LENGTH_BYTES = 32

export async function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    const e = new Error('password is required')
    e.name = 'ValidationError'
    throw e
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH_BYTES)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(derived)}`
}

/** 저장된 password_hash 문자열로 평문 비밀번호를 검증한다(상수시간 비교). 형식 오류는 안전하게 false. */
export async function verifyPassword(password, stored) {
  if (!password || !stored) return false
  const parts = String(stored).split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number.parseInt(parts[1], 10)
  if (!Number.isInteger(iterations) || iterations <= 0) return false
  let salt
  let expected
  try {
    salt = fromHex(parts[2])
    expected = fromHex(parts[3])
  } catch {
    return false
  }
  const actual = await pbkdf2(password, salt, iterations, expected.length)
  return timingSafeEqualBytes(actual, expected)
}

async function pbkdf2(password, salt, iterations, keyLenBytes) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, keyMaterial, keyLenBytes * 8)
  return new Uint8Array(bits)
}

// ---------------------------------------------------------------------------
// opaque 토큰 (refresh token, device token 공용) — 원문은 절대 저장하지 않고 SHA-256 해시만 DB에 저장.
// ---------------------------------------------------------------------------
export function generateOpaqueToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return base64UrlEncode(bytes)
}

export async function sha256Hex(raw) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return toHex(new Uint8Array(digest))
}

// ---------------------------------------------------------------------------
// 관리자 신규 계정 생성 시 임시 비밀번호(사람이 읽고 옮겨적기 쉬운 형태) — 응답에 1회만 노출.
// 혼동되는 문자(0/O, 1/l/I 등) 제외한 32자 세트, crypto.getRandomValues 기반.
// ---------------------------------------------------------------------------
const TEMP_PASSWORD_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
const TEMP_PASSWORD_LENGTH = 14

export function generateTempPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(TEMP_PASSWORD_LENGTH))
  let out = ''
  for (const b of bytes) out += TEMP_PASSWORD_CHARS[b % TEMP_PASSWORD_CHARS.length]
  return out
}

// ---------------------------------------------------------------------------
// JWT (jose, HS256) — 웹 로그인 access token
// ---------------------------------------------------------------------------
export const JWT_ISSUER = 'malgnai-hub'
export const JWT_AUDIENCE = 'malgnai-hub-web'
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 4 // 4h(architecture.md §6.1)
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30 // 30일

// [재사용 탐지 grace window] 회전(rotation) 직후 아주 짧은 시간 내에 같은 stale 토큰이 다시
// 들어오는 것은 "탈취"가 아니라 정상 클라이언트의 동시 요청일 가능성이 높다(예: 여러 탭/재시도가
// 병렬로 401→refresh를 트리거). 사내 private 프로젝트(~/workspace/malgnai/server/lib/refresh-token.js,
// 2026-07-13 reviewer 리뷰로 재현·수정된 회귀)에서 이미 검증된 값을 그대로 이식한다 — grace window
// 없이 즉시 전체 revoke하면 방금 회전으로 정상 발급된 최신 토큰까지 collateral로 폐기되어 정상
// 사용자가 강제 로그아웃당한다. revoke_reason==='rotated'인 경우에만 적용하고(logout/이미
// reuse_detected는 즉시 탈취 처리), 이 window를 넘긴 재사용만 진짜 탈취로 간주한다(server/api/auth.js 참고).
export const REUSE_GRACE_MS = 10_000 // 10초

export async function signAccessToken(user, secret) {
  const key = new TextEncoder().encode(secret)
  const now = Math.floor(Date.now() / 1000)
  const token = await new SignJWT({ role: user.role, email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .sign(key)
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS }
}

/** 서명 검증 + 만료 확인 + iss/aud 확인 + alg를 HS256으로 고정(alg 혼동 공격 방지). 실패 시 throw. */
export async function verifyAccessToken(token, secret) {
  const key = new TextEncoder().encode(secret)
  const { payload } = await jwtVerify(token, key, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: ['HS256']
  })
  return payload
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function base64UrlEncode(bytes) {
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex) {
  if (hex.length % 2 !== 0) throw new Error('invalid hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16)
  return out
}
