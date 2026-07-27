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

export async function updateRoleStatus(db, id, { role, status }) {
  const sets = []
  const binds = []
  if (role) { sets.push('role = ?'); binds.push(role) }
  if (status) { sets.push('status = ?'); binds.push(status) }
  if (!sets.length) return
  sets.push('updated_at = ?')
  binds.push(new Date().toISOString())
  binds.push(id)
  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
}
