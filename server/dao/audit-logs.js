// audit_logs 테이블 DAO — 보안 민감 동작(관리자의 타인 데이터 접근·device_token 발급/폐기 등) 기록.
import { newId } from '../lib/ulid.js'

/** INSERT 문 단일 빌더(usage-employee-identity-linking.md §5.5 — "INSERT SQL을 두 벌 만들지 않는다").
 *  db.prepare(...).bind(...) 까지만 만들고 실행(.run())은 호출부가 맡는다 — record()는 단독 실행,
 *  server/dao/users.js의 updateEmployeeIdWithAudit()는 이 statement를 UPDATE와 함께 db.batch()로
 *  원자 커밋한다. */
export function buildRecordStatement(db, { actorUserId, action, targetType, targetId, metadata }) {
  const id = newId()
  const now = new Date().toISOString()
  const stmt = db.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, actorUserId, action, targetType || null, targetId || null, metadata ? JSON.stringify(metadata) : null, now)
  return { id, stmt }
}

export async function record(db, { actorUserId, action, targetType, targetId, metadata }) {
  const { id, stmt } = buildRecordStatement(db, { actorUserId, action, targetType, targetId, metadata })
  await stmt.run()
  return id
}
