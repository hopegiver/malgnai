// 회전형(rotating) opaque 토큰의 발급/회전/재사용탐지를 테이블 비의존적으로 구현한 공용 함수.
// 원래 server/api/auth.js의 POST /refresh 핸들러(웹 로그인용 refresh_tokens 테이블)에 있던
// "회전 + 10초 grace window + 재사용탐지" 알고리즘을 함수화한 것 — OAuth refresh 경로
// (server/dao/oauth-refresh-tokens.js)와 웹 로그인 refresh 경로(server/dao/refresh-tokens.js,
// server/api/auth.js) 둘 다 이 함수 하나를 공유한다(security 리뷰 H1 수정을 계기로 통합 —
// 같은 레이스 버그를 두 곳에 따로 갖지 않도록 리팩터링 완료).
//
// [2026-09-15] MCP OAuth 축의 다중 창 동시요청 오탐(30초에 11회 연속 강제 로그아웃, 프로덕션
// 실측)을 고치면서도 이 통합을 유지한다 — 함수를 쪼개지 않고 축별로 다른 것은 오직 "정책"
// (grace 길이, grace 밖 stale 재사용을 가족 폐기할지 요청만 거절할지)뿐이다. 정책은 4번째 인자
// `policy`로 주입한다(기본값은 엄격한 웹 정책 — fail-safe default). 판정 구조·근거 전문은
// docs/design/oauth-refresh-race-mitigation.md §3(현재 구조가 왜 연쇄로 확정되는지)·§4(새 알고리즘).
import { REUSE_GRACE_MS, OAUTH_REUSE_GRACE_MS } from './tokens.js'

export const REVOKE_FAMILY = 'revoke_family'
export const REJECT_ONLY = 'reject_only'

/** 웹 로그인 축(server/api/auth.js) — 현행 동작 100% 보존. 인자를 생략했을 때의 기본값이기도
 *  하다(fail-safe default — 미래의 새 호출자가 policy를 잊어도 느슨해지지 않고 엄격해진다). */
export const WEB_REFRESH_POLICY = Object.freeze({
  graceMs: REUSE_GRACE_MS, onStaleOutOfGrace: REVOKE_FAMILY, label: 'web'
})

/** MCP OAuth 축(server/api/oauth.js) — 다중 창 동시요청을 정상으로 흡수한다(설계 §2·§7). */
export const MCP_OAUTH_REFRESH_POLICY = Object.freeze({
  graceMs: OAUTH_REUSE_GRACE_MS, onStaleOutOfGrace: REJECT_ONLY, label: 'mcp_oauth'
})

/**
 * 저장된 토큰 레코드를 조회해 판정하고, 정상 회전이면 markRotated까지 수행한다.
 *
 * @param {object} db - D1 database
 * @param {string} tokenHash - sha256Hex(rawToken)
 * @param {object} dao - 호출자가 테이블에 맞게 주입하는 DAO 어댑터
 * @param {(db: object, tokenHash: string) => Promise<object|undefined>} dao.findByHash
 * @param {(db: object, id: string) => Promise<boolean>} dao.markRotated - status='active' 토큰을 회전 처리(status='rotated')
 * @param {(db: object, stored: object, reason: string) => Promise<void>} dao.revokeAll - 재사용(탈취) 탐지 시 연관 토큰 그룹 전체 폐기.
 *   `stored`(조회된 원본 행)를 그대로 넘기므로 호출자가 어떤 컬럼(device_token_id 등)으로 그룹을
 *   묶을지 자유롭게 정할 수 있다.
 * @param {{graceMs: number, onStaleOutOfGrace: 'revoke_family'|'reject_only', label: string}} [policy]
 *   호출축의 위험 감수 수준(§5.3 — dao 어댑터는 "어느 테이블인가", policy는 "어느 축인가"라서
 *   성격이 다르다). 생략 시 WEB_REFRESH_POLICY(엄격).
 * @returns {Promise<
 *   | { ok: false, reason: 'invalid', detail: 'not_found' | 'expired' }
 *   | { ok: false, reason: 'reuse_detected', stored: object, trigger: 'explicit_revoke'|'stale_out_of_grace', staleAgeMs?: number, entry: 'stale'|'race' }
 *   | { ok: false, reason: 'stale_reuse', stored: object, staleAgeMs: number, entry: 'stale'|'race' }
 *   | { ok: false, reason: 'already_revoked', stored: object, entry: 'stale'|'race' }
 *   | { ok: true, stored: object, path: 'rotated' }
 *   | { ok: true, stored: object, path: 'grace', staleAgeMs: number, entry: 'stale'|'race' }
 * >}
 *   `ok: true`면 정상 사용(최초 사용 시 회전 완료, grace window 재사용 시 회전 없이 재발급만) —
 *   호출자는 이 결과를 받아 새 토큰 쌍을 발급하면 된다. `reason: 'reuse_detected'`면 dao.revokeAll이
 *   이미 호출된 뒤이므로(연관 그룹 전체 폐기 완료) 호출자는 감사 로그 기록 등 후속 조치만 하면 된다.
 *   `reason: 'stale_reuse'`(MCP reject_only 정책 전용)·`'already_revoked'`(두 정책 공통, D4)는
 *   revokeAll을 호출하지 않는다 — 가족의 판정 근거(revoke_reason='rotated', 실제 revoked_at)가
 *   보존되어 뒤따르는 요청들이 계속 자기 나이로 판정받는다(연쇄 확정 경로 차단).
 */
export async function rotateOrDetectReuse(db, tokenHash, dao, policy = WEB_REFRESH_POLICY) {
  const stored = await dao.findByHash(db, tokenHash)
  if (!stored) return { ok: false, reason: 'invalid', detail: 'not_found' }

  if (stored.status === 'active') {
    if (new Date(stored.expires_at).getTime() < Date.now()) {
      return { ok: false, reason: 'invalid', detail: 'expired' }
    }
    // 조건부 UPDATE(status='active')라 동시 요청 중 하나만 실제로 행을 바꾼다(security 리뷰 H1 —
    // 예전엔 이 성패를 확인하지 않아 동시 재사용이 탐지 없이 통과했다).
    if (await dao.markRotated(db, stored.id)) {
      return { ok: true, stored, path: 'rotated' }
    }
    // 레이스에서 졌다 — 다른 동시 요청이 방금 이 토큰을 이미 회전시켰다는 뜻이다. 이건 별개
    // 요청이 오래된 토큰을 재사용한 것과 구분할 수 없으므로, 재조회해 stale 판정과 똑같은
    // 잣대를 적용한다.
    const refetched = await dao.findByHash(db, tokenHash)
    return judgeStale(db, refetched ?? stored, dao, policy, 'race')
  }

  return judgeStale(db, stored, dao, policy, 'stale')
}

async function judgeStale(db, stored, dao, policy, entry) {
  // (a) 회전이 아닌 사유로 죽은 토큰 — 모호하지 않다.
  if (stored.revoke_reason !== 'rotated') {
    if (stored.revoke_reason === 'reuse_detected') {
      // D4: 이미 탈취 판정으로 폐기된 가족. 다시 폐기해도 새로 지킬 것이 없고, 그 사이 사람이
      // 재인증해 만든 새 세션만 소급 사살한다(실측 4건, 설계 §2.4). 요청만 거절한다.
      return { ok: false, reason: 'already_revoked', stored, entry }
    }
    if (stored.revoke_reason == null) {
      // reviewer 리뷰 m3: 이건 "명시적 폐기"가 아니다 — entry==='race'에서 재조회(findByHash)가
      // undefined를 반환했을 때 rotateOrDetectReuse의 `refetched ?? stored` 폴백으로 회전 전
      // active 스냅샷(아직 한 번도 폐기된 적 없어 revoke_reason이 null)이 그대로 들어온 경우뿐이다
      // ('rotated'/'logout'/'device_revoked'/'reuse_detected'로 폐기된 행은 항상 revoke_reason이
      // 함께 기록된다 — server/dao/oauth-refresh-tokens.js, server/dao/refresh-tokens.js). 판정
      // (가족 폐기, fail-closed)은 그대로 두되, trigger 라벨만 실제 사유로 분리한다 — 감사로그
      // 사후분석에서 "관리자가 폐기한 디바이스를 누가 재사용했다"로 오독되는 것을 막는다.
      await dao.revokeAll(db, stored, 'reuse_detected')
      return { ok: false, reason: 'reuse_detected', stored, trigger: 'refetch_missing', entry }
    }
    // 'logout' | 'device_revoked' — 명시적 폐기 이후의 사용은 전부 탈취로 간주.
    await dao.revokeAll(db, stored, 'reuse_detected')
    return { ok: false, reason: 'reuse_detected', stored, trigger: 'explicit_revoke', entry }
  }

  // (b) 정상 회전된 토큰의 재제시 — 나이로만 판단한다.
  const staleAgeMs = stored.revoked_at
    ? Date.now() - new Date(stored.revoked_at).getTime()
    : Number.POSITIVE_INFINITY // revoked_at 결손은 fail-closed(무한대 = grace 밖)
  if (staleAgeMs <= policy.graceMs) {
    return { ok: true, stored, path: 'grace', staleAgeMs, entry }
  }
  if (policy.onStaleOutOfGrace === REJECT_ONLY) {
    // D3: 가족을 건드리지 않는다 — 판정 근거(revoke_reason='rotated', 실제 revoked_at)가 보존되어
    //     뒤따르는 요청들이 계속 자기 나이로 판정받는다(연쇄 확정 경로 차단, 설계 §3).
    return { ok: false, reason: 'stale_reuse', stored, staleAgeMs, entry }
  }
  await dao.revokeAll(db, stored, 'reuse_detected')
  return { ok: false, reason: 'reuse_detected', stored, staleAgeMs, trigger: 'stale_out_of_grace', entry }
}
