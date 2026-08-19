// oauth_refresh_tokens 테이블 DAO — device_tokens(OAuth로 발급된 access token)와 1:1로 연결되는
// 회전형 opaque refresh token. server/lib/rotating-token.js가 요구하는 인터페이스(findByHash,
// markRotated, revokeAll)에 얇게 맞춰 구현한다.
import { newId } from '../lib/ulid.js'

export async function insert(db, { deviceTokenId, tokenHash, expiresAt }) {
  const id = newId()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO oauth_refresh_tokens (id, device_token_id, token_hash, status, expires_at, created_at)
     VALUES (?, ?, ?, 'active', ?, ?)`
  ).bind(id, deviceTokenId, tokenHash, expiresAt, now).run()
  return { id, device_token_id: deviceTokenId, token_hash: tokenHash, status: 'active', expires_at: expiresAt, created_at: now }
}

export async function findByHash(db, tokenHash) {
  return db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?').bind(tokenHash).first()
}

/** 정상 회전(최초 사용) — revoke_reason='rotated'로 마킹해 grace window 판정의 기준을 남긴다.
 *  status='active' 조건부 UPDATE라 동시 회전 요청 중 하나만 실제로 행을 바꾼다 — 그 성패를
 *  호출자(rotating-token.js)가 판단할 수 있도록 changes>0 여부를 반환한다(security 리뷰 H1). */
export async function markRotated(db, id) {
  const now = new Date().toISOString()
  const res = await db.prepare(
    "UPDATE oauth_refresh_tokens SET status='rotated', revoke_reason='rotated', revoked_at=? WHERE id = ? AND status='active'"
  ).bind(now, id).run()
  return res.meta.changes > 0
}

/** 특정 device_token_id에 연결된 refresh token만 전부 폐기한다 — 웹 refresh(유저 전체 폐기)와
 *  달리 "그 디바이스 하나만" 폐기하고 같은 유저의 다른 디바이스는 건드리지 않는다. */
export async function revokeAllForDeviceToken(db, deviceTokenId, reason = 'reuse_detected') {
  await db.prepare(
    "UPDATE oauth_refresh_tokens SET status='revoked', revoke_reason=?, revoked_at=? WHERE device_token_id = ? AND status != 'revoked'"
  ).bind(reason, new Date().toISOString(), deviceTokenId).run()
}
