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

/** buildRecordStatement의 CAS 판(M-2 수정, 리뷰 2026-09-07 — server/dao/users.js
 *  buildUpdateEmployeeIdStatement의 `AND employee_id IS ?`와 짝) — 같은 db.batch() 안에서 바로 앞
 *  statement(CAS UPDATE)가 실제로 행을 바꿨을 때만 이 감사 INSERT를 실행한다. 두 관리자가 동시에
 *  같은 사용자를 편집해 뒤쳐진 요청의 UPDATE가 CAS 불일치로 0행이면, 이 statement도 함께 no-op이 돼
 *  "일어나지 않은 변경"이 감사로그에 남지 않는다 — 이게 없으면 UPDATE는 CAS로 막았어도 INSERT는
 *  무조건 실행돼 틀린 `before/after`가 그대로 기록된다(M-2가 고치려는 바로 그 결함).
 *  `(SELECT changes())`는 SQLite 스칼라 함수로, db.batch()가 한 트랜잭션·한 커넥션에서 statement를
 *  순차 실행하므로 바로 앞 UPDATE가 바꾼 행 수를 그대로 본다(로컬 --local 실기동으로 실측 확인,
 *  §완료판정 4). 호출부(admin-users.js)는 batch 결과의 update `meta.changes`로 CAS 성패를 별도
 *  판정해 409를 응답한다 — 이 함수는 "일어난 변경만 정확히 기록한다"만 책임진다. */
export function buildRecordStatementIfPrecedingChanged(db, { actorUserId, action, targetType, targetId, metadata }) {
  const id = newId()
  const now = new Date().toISOString()
  const stmt = db.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT changes()) > 0`
  ).bind(id, actorUserId, action, targetType || null, targetId || null, metadata ? JSON.stringify(metadata) : null, now)
  return { id, stmt }
}
