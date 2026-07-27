// audit_logs 테이블 DAO — 보안 민감 동작(관리자의 타인 데이터 접근·device_token 발급/폐기 등) 기록.
import { newId } from '../lib/ulid.js'

export async function record(db, { actorUserId, action, targetType, targetId, metadata }) {
  const id = newId()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, actorUserId, action, targetType || null, targetId || null, metadata ? JSON.stringify(metadata) : null, now).run()
  return id
}
