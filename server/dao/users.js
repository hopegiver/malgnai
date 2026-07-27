// users 테이블 DAO — organizations 없음(architecture.md §0-7), UNIQUE(email)이 전사 유일 식별자.
import { newId } from '../lib/ulid.js'

export async function findByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first()
}

export async function findById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()
}

export async function insert(db, { email, name, passwordHash, role = 'employee' }) {
  const id = newId()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  ).bind(id, email, name || null, passwordHash, role, now, now).run()
  return { id, email, name: name || null, role, status: 'active', created_at: now, updated_at: now }
}

/** 시드 스크립트 전용 — 이미 있으면 비밀번호/이름/role을 갱신(UPSERT), 없으면 새로 만든다. */
export async function upsertByEmail(db, { email, name, passwordHash, role = 'administrator' }) {
  const existing = await findByEmail(db, email)
  const now = new Date().toISOString()
  if (existing) {
    await db.prepare('UPDATE users SET name = ?, password_hash = ?, role = ?, updated_at = ? WHERE id = ?')
      .bind(name || existing.name, passwordHash, role, now, existing.id).run()
    return { ...existing, name: name || existing.name, password_hash: passwordHash, role, updated_at: now }
  }
  return insert(db, { email, name, passwordHash, role })
}

export async function listAll(db) {
  const { results } = await db.prepare('SELECT id, email, name, role, status, created_at FROM users ORDER BY created_at DESC').all()
  return results
}

/** 관리자 PATCH /api/admin/users/:id 전용 — name/role/status 부분 갱신(server/api/admin-users.js). */
export async function updateRoleStatus(db, id, { name, role, status }) {
  const sets = []
  const binds = []
  if (name !== undefined) { sets.push('name = ?'); binds.push(name) }
  if (role) { sets.push('role = ?'); binds.push(role) }
  if (status) { sets.push('status = ?'); binds.push(status) }
  if (!sets.length) return
  sets.push('updated_at = ?')
  binds.push(new Date().toISOString())
  binds.push(id)
  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
}

/** 본인 PATCH /api/auth/me 전용 — name만 갱신 가능(email/role/status는 이 경로로 불가, server/api/auth.js). */
export async function updateName(db, id, name) {
  await db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?')
    .bind(name, new Date().toISOString(), id).run()
}

/** 비밀번호 변경(server/api/auth.js POST /change-password) — password_hash만 갱신. */
export async function updatePasswordHash(db, id, passwordHash) {
  await db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(passwordHash, new Date().toISOString(), id).run()
}

/** 활성 administrator 인원 수 — 마지막 남은 관리자를 강등/비활성화하지 못하게 막는 가드에 사용
 *  (server/api/admin-users.js PATCH /:id). */
export async function countActiveAdmins(db) {
  const row = await db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'administrator' AND status = 'active'").first()
  return row ? row.cnt : 0
}
