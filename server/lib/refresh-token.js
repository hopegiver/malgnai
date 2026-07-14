// refresh token(장기, 30일, 회전형) 생성/해시 유틸.
//
// JWT가 아니라 랜덤 opaque 토큰이다(access token은 signJwt로 그대로 4h JWT를 유지).
// opaque로 만드는 이유: revoke가 DB 삭제/마킹만으로 즉시 가능해야 하기 때문(JWT는 만료 전
// 즉시 무효화가 불가능해 이 용도에 안 맞음). 원문은 절대 저장하지 않고 SHA-256 해시만
// DB(refresh_tokens.token_hash)에 저장한다 — 비밀번호 해싱과 동일한 철학(DB 유출 시에도
// 원문 토큰을 복원할 수 없어야 함).

export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30 // 30일

// [재사용 탐지 grace window] 회전(rotation) 직후 아주 짧은 시간 내에 같은 stale 토큰이
// 다시 들어오는 것은 "탈취"가 아니라 "정상 클라이언트의 동시 요청"일 가능성이 높다
// (예: PWA 탭을 오래 열어뒀다가 재오픈 시 여러 API 가 병렬로 401→refresh 를 트리거하는
// 경우, app/layouts/default.vue 의 Promise.allSettled 병렬 호출이 실제로 이 패턴을 만든다).
// reviewer 리뷰(docs/reviewer/review-refresh-token-auth-2026-07-13.md) 재현 확인: grace
// window 없이 즉시 전체 revoke하면, 방금 회전으로 정상 발급된 최신 토큰까지 collateral로
// 폐기되어 정상 사용자가 강제 로그아웃당한다. OAuth 계열의 표준 완화책을 따라 회전 후
// REUSE_GRACE_MS 이내의 stale 토큰 재사용은 "탈취 신호"로 취급하지 않고 그냥 새 쌍을
// 하나 더 발급한다(다른 세션은 건드리지 않음) — grace window 를 넘긴 재사용만 진짜 탈취로
// 간주해 그 유저의 모든 refresh token 을 강제 revoke한다.
export const REUSE_GRACE_MS = 10_000 // 10초

/** 32바이트 랜덤값을 base64url로 인코딩한 opaque refresh token 원문을 생성한다. */
export function generateRefreshToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return base64UrlEncode(bytes)
}

/** refresh token 원문을 SHA-256 해시(hex 문자열)로 변환한다. DB에는 이 값만 저장한다. */
export async function hashRefreshToken(raw) {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toHex(digest)
}

function base64UrlEncode(bytes) {
  const str = String.fromCharCode(...bytes)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
