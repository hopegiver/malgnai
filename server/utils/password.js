// 비밀번호 해시 유틸 — Node 내장 crypto.scrypt 만 사용(외부 의존 없음).
//
// 저장 형식: password_hash(=scrypt 파생키 hex), password_salt(=랜덤 salt hex).
// 검증은 timingSafeEqual 로 상수시간 비교(틀린 길이는 길이 차이로 즉시 false).
// 평문은 절대 저장하지 않는다.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const KEYLEN = 64 // scrypt 파생키 바이트 수
const SALT_BYTES = 16

function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}

/**
 * 비밀번호를 해시한다. → { hash, salt } (둘 다 hex 문자열)
 * salt 는 호출마다 새로 생성한다.
 */
export async function hashPassword(password) {
  const saltBuf = randomBytes(SALT_BYTES)
  const derived = await scryptAsync(String(password), saltBuf, KEYLEN)
  return { hash: derived.toString('hex'), salt: saltBuf.toString('hex') }
}

/**
 * 저장된 hash/salt 로 비밀번호를 검증한다(상수시간 비교).
 * 입력이 잘못되면(누락/형식오류) 안전하게 false 를 돌려준다.
 */
export async function verifyPassword(password, hashHex, saltHex) {
  if (!password || !hashHex || !saltHex) return false
  let saltBuf
  let storedBuf
  try {
    saltBuf = Buffer.from(saltHex, 'hex')
    storedBuf = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }
  if (storedBuf.length === 0) return false
  const derived = await scryptAsync(String(password), saltBuf, storedBuf.length)
  // 길이가 다르면 timingSafeEqual 이 던지므로 먼저 길이 확인(이미 keylen 으로 맞춤).
  if (derived.length !== storedBuf.length) return false
  return timingSafeEqual(derived, storedBuf)
}
