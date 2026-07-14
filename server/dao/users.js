// users DAO — D1 호환 어댑터 패턴(db.prepare(sql).bind(...).first()/.all()/.run()).
//
// 사용자 테이블 기반 로그인 + TOTP(2차 인증) 백엔드.
// 컬럼: id(uuid), username(unique), password_hash, password_salt,
//       totp_secret(nullable), totp_enabled(0/1), created_at, updated_at.

import { normalizeRole } from '../lib/roles.js'

export default class UsersDao {
  constructor(db) { this.db = db }

  async findByUsername(username) {
    return await this.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .bind(username)
      .first()
  }

  async findById(id) {
    return await this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(id)
      .first()
  }

  async count() {
    const row = await this.db.prepare('SELECT COUNT(*) AS c FROM users').first()
    return row ? row.c : 0
  }

  /** 최고관리자(role='super_admin') 수 — 마지막 최고관리자 삭제/강등 방지에 사용. */
  async countSuperAdmins() {
    const row = await this.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin'").first()
    return row ? row.c : 0
  }

  /**
   * 사용자 목록(관리 화면용). 비밀번호 해시/salt·totp_secret 은 절대 노출하지 않는다.
   */
  async list() {
    const res = await this.db.prepare(
      'SELECT id, username, role, totp_enabled, created_at, updated_at FROM users ORDER BY created_at ASC, username ASC'
    ).all()
    return res.results
  }

  /**
   * 사용자 생성. password_hash/password_salt 는 호출 측에서 hashPassword 로 만든 값.
   * totp 는 기본 비활성(secret=null, enabled=0).
   * role 은 호출 측(server/api/users.js 등)이 이미 화이트리스트 검증하지만, 향후 다른 호출부
   * (스크립트·MCP 등)가 검증을 생략해도 임의 문자열이 저장되지 않도록 DAO 자체에서도
   * normalizeRole 로 한 번 더 화이트리스트를 강제한다(방어적 이중화).
   */
  async create({ username, passwordHash, passwordSalt, role = 'user' }) {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await this.db.prepare(
      `INSERT INTO users (id, username, password_hash, password_salt, role, totp_secret, totp_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`
    ).bind(id, username, passwordHash, passwordSalt, normalizeRole(role), now, now).run()
    return await this.findById(id)
  }

  /**
   * TOTP secret + enabled 상태를 함께 설정한다.
   * - setup: secret 저장 + enabled=0(pending)
   * - enable: enabled=1 (secret 유지)
   * - disable: secret=null + enabled=0
   */
  async setTotp(username, secret, enabled) {
    const now = new Date().toISOString()
    const res = await this.db.prepare(
      'UPDATE users SET totp_secret = ?, totp_enabled = ?, updated_at = ? WHERE username = ?'
    ).bind(secret ?? null, enabled ? 1 : 0, now, username).run()
    return res.meta.changes > 0
  }

  async updatePassword(username, passwordHash, passwordSalt) {
    const now = new Date().toISOString()
    const res = await this.db.prepare(
      'UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE username = ?'
    ).bind(passwordHash, passwordSalt, now, username).run()
    return res.meta.changes > 0
  }

  /** id 기준 username 변경. UNIQUE 제약 위반(중복)은 호출 측에서 try/catch. */
  async updateUsername(id, username) {
    const now = new Date().toISOString()
    const res = await this.db.prepare(
      'UPDATE users SET username = ?, updated_at = ? WHERE id = ?'
    ).bind(username, now, id).run()
    return res.meta.changes > 0
  }

  /** id 기준 비밀번호 재설정(관리자가 다른 사용자 비번을 바꿀 때). */
  async updatePasswordById(id, passwordHash, passwordSalt) {
    const now = new Date().toISOString()
    const res = await this.db.prepare(
      'UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?'
    ).bind(passwordHash, passwordSalt, now, id).run()
    return res.meta.changes > 0
  }

  /** id 기준 권한(role) 변경. normalizeRole 로 방어적 화이트리스트 강제(create() 참고). */
  async updateRole(id, role) {
    const now = new Date().toISOString()
    const res = await this.db.prepare(
      'UPDATE users SET role = ?, updated_at = ? WHERE id = ?'
    ).bind(normalizeRole(role), now, id).run()
    return res.meta.changes > 0
  }

  async delete(id) {
    const res = await this.db.prepare('DELETE FROM users WHERE id = ?').bind(id).run()
    return res.meta.changes > 0
  }
}
