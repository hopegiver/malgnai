// 회전형(rotating) opaque 토큰의 발급/회전/재사용탐지를 테이블 비의존적으로 구현한 공용 함수.
// 원래 server/api/auth.js의 POST /refresh 핸들러(웹 로그인용 refresh_tokens 테이블)에 있던
// "회전 + 10초 grace window + 재사용탐지" 알고리즘을 함수화한 것 — OAuth refresh 경로
// (server/dao/oauth-refresh-tokens.js)와 웹 로그인 refresh 경로(server/dao/refresh-tokens.js,
// server/api/auth.js) 둘 다 이 함수 하나를 공유한다(security 리뷰 H1 수정을 계기로 통합 —
// 같은 레이스 버그를 두 곳에 따로 갖지 않도록 리팩터링 완료).
import { REUSE_GRACE_MS } from './tokens.js'

/**
 * 저장된 토큰 레코드를 조회해 판정하고, 정상 회전이면 markRotated까지 수행한다.
 *
 * @param {object} db - D1 database
 * @param {string} tokenHash - sha256Hex(rawToken)
 * @param {object} dao - 호출자가 테이블에 맞게 주입하는 DAO 어댑터
 * @param {(db: object, tokenHash: string) => Promise<object|undefined>} dao.findByHash
 * @param {(db: object, id: string) => Promise<void>} dao.markRotated - status='active' 토큰을 회전 처리(status='rotated')
 * @param {(db: object, stored: object, reason: string) => Promise<void>} dao.revokeAll - 재사용(탈취) 탐지 시 연관 토큰 그룹 전체 폐기.
 *   `stored`(조회된 원본 행)를 그대로 넘기므로 호출자가 어떤 컬럼(device_token_id 등)으로 그룹을
 *   묶을지 자유롭게 정할 수 있다.
 * @returns {Promise<
 *   | { ok: false, reason: 'invalid', detail: 'not_found' | 'expired' }
 *   | { ok: false, reason: 'reuse_detected', stored: object }
 *   | { ok: true, stored: object }
 * >}
 *   `ok: true`면 정상 사용(최초 사용 시 회전 완료, grace window 재사용 시 회전 없이 재발급만) —
 *   호출자는 이 결과를 받아 새 토큰 쌍을 발급하면 된다. `reason: 'reuse_detected'`면 dao.revokeAll이
 *   이미 호출된 뒤이므로(연관 그룹 전체 폐기 완료) 호출자는 감사 로그 기록 등 후속 조치만 하면 된다.
 */
export async function rotateOrDetectReuse(db, tokenHash, dao) {
  const stored = await dao.findByHash(db, tokenHash)
  if (!stored) {
    return { ok: false, reason: 'invalid', detail: 'not_found' }
  }

  if (stored.status !== 'active') {
    // 이미 회전(또는 폐기)된 토큰이 다시 들어옴 — 정상 회전 직후 grace window 이내의 재사용만
    // 예외적으로 허용(동시 요청/재시도 레이스), 그 외(만료 grace 초과, revoked 상태)는 탈취로 간주.
    const elapsedMs = stored.revoked_at ? Date.now() - new Date(stored.revoked_at).getTime() : Number.POSITIVE_INFINITY
    const withinGrace = stored.revoke_reason === 'rotated' && elapsedMs <= REUSE_GRACE_MS
    if (!withinGrace) {
      await dao.revokeAll(db, stored, 'reuse_detected')
      return { ok: false, reason: 'reuse_detected', stored }
    }
    // grace window 이내 — 이 토큰은 이미 revoke되어 있으니 추가 회전 없이 새 쌍만 재발급한다.
    return { ok: true, stored }
  }

  if (new Date(stored.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'invalid', detail: 'expired' }
  }

  // 회전(rotation): status='active' 조건부 UPDATE라 동시에 들어온 두 요청 중 하나만 실제로
  // 행을 바꾼다(security 리뷰 H1 — 예전엔 이 성패를 확인하지 않아 동시 재사용이 탐지 없이 통과했다).
  const rotated = await dao.markRotated(db, stored.id)
  if (rotated) {
    return { ok: true, stored }
  }

  // 레이스에서 졌다 — 다른 동시 요청이 방금 이 토큰을 이미 회전시켰다는 뜻이다. 이건 별개
  // 요청이 오래된 토큰을 재사용한 것과 구분할 수 없으므로, 재조회해 "정상 회전 직후 grace
  // window 이내 재사용"과 동일한 기준을 적용한다 — grace 안이면 동시 요청으로 보고 허용,
  // 벗어나면(레이스가 아니라 실제 지연 재사용이면) 탈취로 간주해 즉시 폐기한다.
  const refetched = await dao.findByHash(db, tokenHash)
  if (refetched && refetched.status === 'rotated' && refetched.revoke_reason === 'rotated') {
    const elapsedMs = refetched.revoked_at ? Date.now() - new Date(refetched.revoked_at).getTime() : Number.POSITIVE_INFINITY
    if (elapsedMs <= REUSE_GRACE_MS) {
      return { ok: true, stored: refetched }
    }
  }
  await dao.revokeAll(db, stored, 'reuse_detected')
  return { ok: false, reason: 'reuse_detected', stored }
}
