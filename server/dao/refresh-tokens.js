// refresh_tokens 테이블 DAO — [문서 갭 보완] 사유는 migrations/0001_init_v1_schema.sql 상단 주석 참고.
// revoke_reason/재사용 grace window는 migrations/0002_add_refresh_token_revoke_reason.sql 참고
// (사내 private 프로젝트 ~/workspace/malgnai에서 검증된 패턴 이식).
import { newId } from '../lib/ulid.js'

export async function insert(db, { userId, tokenHash, expiresAt }) {
  const id = newId()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, status, expires_at, created_at)
     VALUES (?, ?, ?, 'active', ?, ?)`
  ).bind(id, userId, tokenHash, expiresAt, now).run()
  return { id, user_id: userId, token_hash: tokenHash, status: 'active', expires_at: expiresAt, created_at: now }
}

export async function findByHash(db, tokenHash) {
  return db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').bind(tokenHash).first()
}

/** 정상 회전(최초 사용) — revoke_reason='rotated'로 마킹해 grace window 판정의 기준을 남긴다. */
export async function markRotated(db, id) {
  const now = new Date().toISOString()
  await db.prepare(
    "UPDATE refresh_tokens SET status='rotated', revoke_reason='rotated', revoked_at=? WHERE id = ? AND status='active'"
  ).bind(now, id).run()
}

/** 재사용 탐지(grace window 밖 재사용, 또는 logout/이미 reuse_detected된 토큰의 재사용) 시
 *  해당 유저의 모든 refresh token을 일괄 폐기(api.md §5.1) — revoke_reason='reuse_detected'로
 *  남겨 이후 이 토큰들이 다시 들어와도 grace window 대상이 되지 않게 한다. */
export async function revokeAllForUser(db, userId) {
  await db.prepare(
    "UPDATE refresh_tokens SET status='revoked', revoke_reason='reuse_detected', revoked_at=? WHERE user_id = ? AND status != 'revoked'"
  ).bind(new Date().toISOString(), userId).run()
}
