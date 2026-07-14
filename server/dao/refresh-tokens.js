// refresh_tokens DAO — D1 호환 어댑터 패턴(db.prepare(sql).bind(...).first()/.all()/.run()).
//
// access JWT(4h) 연장을 위한 장기(30일) 회전형 refresh token 저장소. 원문은 저장하지 않고
// SHA-256 해시(token_hash)만 저장한다(server/lib/refresh-token.js 참고).
// 컬럼: id(uuid), user_id, token_hash(unique), created_at, expires_at, revoked_at(nullable),
//       revoke_reason(nullable — 'rotated'|'logout'|'reuse_detected').
//
// [revoke_reason 존재 이유] refresh 재사용 grace window(REUSE_GRACE_MS, server/api/auth.js)는
// "정상 회전 직후 짧은 시간 내 같은 stale 토큰 재사용"만 허용해야 한다. revoked_at 타임스탬프만
// 보면 logout이나 탈취탐지로 revoke된 토큰도 '방금 revoke됨'처럼 보여 grace window에 걸려
// 부활해버리는 회귀가 있었다(2026-07-13). revoke_reason='rotated'인 행만 grace 대상으로 삼고,
// 'logout'/'reuse_detected'는 재사용 시 항상 즉시 거부한다.

export default class RefreshTokensDao {
  constructor(db) { this.db = db }

  /** 새 refresh token 행을 생성한다. expiresAt/createdAt은 ISO 문자열. */
  async create(userId, tokenHash, expiresAt) {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await this.db.prepare(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, created_at, expires_at, revoked_at, revoke_reason)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`
    ).bind(id, userId, tokenHash, now, expiresAt).run()
    return { id, user_id: userId, token_hash: tokenHash, created_at: now, expires_at: expiresAt, revoked_at: null, revoke_reason: null }
  }

  async findByHash(tokenHash) {
    return await this.db
      .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
      .bind(tokenHash)
      .first()
  }

  /**
   * 해당 해시의 토큰을 revoke 처리한다.
   * reason: 'rotated'(정상 회전 — grace window 대상) | 'logout'(명시적 로그아웃 — grace 없이 즉시 거부).
   */
  async revokeByHash(tokenHash, reason) {
    const now = new Date().toISOString()
    const res = await this.db.prepare(
      'UPDATE refresh_tokens SET revoked_at = ?, revoke_reason = ? WHERE token_hash = ? AND revoked_at IS NULL'
    ).bind(now, reason || 'logout', tokenHash).run()
    return res.meta.changes > 0
  }

  /**
   * 해당 유저의 아직 revoke되지 않은 토큰을 전부 revoke('reuse_detected')한다.
   * [탈취 감지 방어] 이미 회전(rotate)되어 revoke된 refresh token이 grace window 밖에서
   * 재사용되면 탈취 신호로 간주하고, 그 유저의 모든 세션(refresh token)을 강제 만료시켜
   * 공격자의 지속 접근을 차단한다. reason='reuse_detected'로 마킹해 grace window 재적용을 막는다.
   */
  async revokeAllForUser(userId) {
    const now = new Date().toISOString()
    const res = await this.db.prepare(
      "UPDATE refresh_tokens SET revoked_at = ?, revoke_reason = 'reuse_detected' WHERE user_id = ? AND revoked_at IS NULL"
    ).bind(now, userId).run()
    return res.meta.changes
  }

  /** 만료된 토큰 정리(로그인 시 opportunistic cleanup). 필수는 아니고 테이블 비대화 방지용. */
  async deleteExpiredForUser(userId) {
    const now = new Date().toISOString()
    const res = await this.db.prepare(
      'DELETE FROM refresh_tokens WHERE user_id = ? AND expires_at < ?'
    ).bind(userId, now).run()
    return res.meta.changes
  }
}
