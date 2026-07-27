// device_tokens 테이블 DAO — MCP 인증 축(architecture.md §6.1). "허용 프로젝트" 컬럼 없음(§0 결정6).
import { newId } from '../lib/ulid.js'

export async function insert(db, { userId, deviceId, deviceName, tokenHash }) {
  const id = newId()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO device_tokens (id, user_id, device_id, device_name, token_hash, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`
  ).bind(id, userId, deviceId, deviceName || null, tokenHash, now).run()
  return { id, user_id: userId, device_id: deviceId, device_name: deviceName || null, status: 'active', created_at: now }
}

export async function findActiveByHash(db, tokenHash) {
  return db.prepare("SELECT * FROM device_tokens WHERE token_hash = ? AND status = 'active'").bind(tokenHash).first()
}

export async function findById(db, id) {
  return db.prepare('SELECT * FROM device_tokens WHERE id = ?').bind(id).first()
}

export async function touchLastUsed(db, id) {
  await db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run()
}

export async function listForUser(db, userId) {
  const { results } = await db.prepare(
    'SELECT id, device_name, status, last_used_at, created_at FROM device_tokens WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all()
  return results
}

/** 즉시 폐기(status='revoked'). 이미 폐기된 토큰은 changes=0. */
export async function revoke(db, id) {
  const now = new Date().toISOString()
  const res = await db.prepare("UPDATE device_tokens SET status='revoked', revoked_at=? WHERE id = ? AND status='active'")
    .bind(now, id).run()
  return res.meta.changes > 0
}
