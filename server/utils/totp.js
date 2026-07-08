// TOTP(Google Authenticator) 유틸 — otplib 13.x 함수형 API 래퍼 + QR data URL.
//
// 직접 HMAC 을 구현하지 않고 otplib 표준 구현을 사용한다. 시계 오차 보정을 위해
// 검증 window=1(±1 step) 을 허용한다.

import { generateSecret, generateSync, generateURI, verifySync } from 'otplib'
import QRCode from 'qrcode'

const ISSUER = 'malgnai'

/** 새 base32 TOTP secret 을 생성한다. */
export function newSecret() {
  return generateSecret()
}

/**
 * otpauth:// URI 를 만든다. label = `malgnai:<username>`, issuer = `malgnai`.
 * (otplib 가 label/issuer 조합을 otpauth://totp/malgnai:<username>?...issuer=malgnai 로 생성)
 */
export function otpauthUrl(username, secret) {
  return generateURI({ secret, label: username, issuer: ISSUER, type: 'totp' })
}

/** otpauth URI 를 QR 코드 PNG data URL(data:image/png;base64,...) 로 만든다. */
export async function qrDataUrl(otpauth) {
  return await QRCode.toDataURL(otpauth, { margin: 1, width: 240 })
}

/** 현재 코드를 즉시 생성한다(검증 테스트/디버깅용, 운영 경로에선 미사용). */
export function generateCode(secret) {
  return generateSync({ secret })
}

/**
 * code 를 secret 으로 검증한다(시계 오차 ±1 step 허용). → boolean.
 * 입력이 잘못되면 안전하게 false.
 */
export function verifyCode(code, secret) {
  if (!code || !secret) return false
  const token = String(code).trim()
  if (!/^\d{6}$/.test(token)) return false
  try {
    const res = verifySync({ token, secret, window: 1 })
    return !!(res && res.valid)
  } catch {
    return false
  }
}
