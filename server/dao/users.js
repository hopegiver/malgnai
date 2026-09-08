// users 테이블 DAO — organizations 없음(architecture.md §0-7), UNIQUE(email)이 전사 유일 식별자.
import { newId } from '../lib/ulid.js'

export async function findByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first()
}

export async function findById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()
}

// employeeId(§5.8 신규 계정 기본값) — 호출부(server/api/admin-users.js POST /)가 이메일 로컬파트
// 파생값을 미리 계산해 넘긴다. 이 함수 자체는 파생하지 않는다(insert는 순수 쓰기 함수).
export async function insert(db, { email, name, passwordHash, role = 'employee', mustChangePassword = false, employeeId = null }) {
  const id = newId()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, status, must_change_password, employee_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
  ).bind(id, email, name || null, passwordHash, role, mustChangePassword ? 1 : 0, employeeId || null, now, now).run()
  return { id, email, name: name || null, role, status: 'active', must_change_password: mustChangePassword ? 1 : 0, employee_id: employeeId || null, created_at: now, updated_at: now }
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

// employee_id 포함(usage-employee-identity-linking.md §12) — 관리자 사용자 목록 화면의 "연동 아이디"
// 열 + GET /api/admin/usage/users 병합(mergeD1AndPromUsers)이 이 컬럼을 그대로 읽는다.
export async function listAll(db) {
  const { results } = await db.prepare('SELECT id, email, name, role, status, employee_id, created_at FROM users ORDER BY created_at DESC').all()
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

/** 비밀번호 변경(server/api/auth.js POST /change-password) — password_hash 갱신 + must_change_password 해제. */
export async function updatePasswordHash(db, id, passwordHash) {
  await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
    .bind(passwordHash, new Date().toISOString(), id).run()
}

/** 활성 administrator 인원 수 — 마지막 남은 관리자를 강등/비활성화하지 못하게 막는 가드에 사용
 *  (server/api/admin-users.js PATCH /:id). */
export async function countActiveAdmins(db) {
  const row = await db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'administrator' AND status = 'active'").first()
  return row ? row.cnt : 0
}

// 로컬파트 충돌 fail-closed 검사(countByEmailLocalPart)는 usage-employee-identity-linking.md §3.3에서
// 폐기됐다 — 부분 UNIQUE 인덱스(idx_users_employee_id, migrations/0020)가 같은 값의 동시 보유를
// DB 수준에서 봉쇄하므로 런타임 검사가 더 이상 필요 없다. 읽기 경로 호출자가 없어 함수 자체를 삭제.

/** 관리자 편집 API(PUT /api/admin/users/:id/employee-id)의 보유자 확인(§5.4) — 다른 사용자가 이미
 *  그 값을 갖고 있으면 409로 거절하고 자동 이전하지 않는다. 단방향 원칙(§3.2 "employee_id로
 *  사용자를 역조회하지 않는다")의 유일한 예외 — administrator 전용 쓰기 경로라 열거 표면이 되지
 *  않는다(§3.3). 부분 UNIQUE 인덱스(idx_users_employee_id)가 이 조회를 그대로 커버한다. */
export async function findByEmployeeId(db, employeeId) {
  return db.prepare('SELECT * FROM users WHERE employee_id = ?').bind(employeeId).first()
}

/** UPDATE 문 단일 빌더(§5.5 원자 커밋) — server/dao/audit-logs.js의 buildRecordStatement()가 만든
 *  감사 INSERT statement와 함께 호출부(server/api/admin-users.js)가 db.batch()로 원자 커밋한다.
 *  이 함수 자체는 실행(.run())하지 않는다 — batch 안에서만 실행돼야 "UPDATE 성공 + 감사로그 실패"
 *  또는 그 반대의 절반 커밋이 생기지 않는다(L5·L6).
 *
 *  M-2 수정(리뷰 2026-09-07) — WHERE에 `AND employee_id IS ?`(서버측 CAS)를 추가했다. previousValue는
 *  호출부가 batch 직전에 읽은 target.employee_id 그대로다. 두 관리자가 동시에 같은 사용자를 편집하면
 *  뒤쳐진 요청의 UPDATE는 이 조건에 걸려 0행이 되고(meta.changes===0), 호출부가 이를 409로 판정한다
 *  — 설계 §5.4가 기각한 것은 "클라이언트가 보내는" expected_current 필드다(프런트 계약 변경). 서버가
 *  자신이 방금 읽은 값을 그대로 WHERE에 되돌리는 이 방식은 프런트에 새 필드를 요구하지 않는다.
 *  `IS`는 SQLite에서 NULL을 안전하게 비교한다(employee_id가 NULL인 미연동 사용자도 `= ?`가 아니라
 *  `IS ?`라 정상 동작).
 *
 *  【공용 워크스테이션 원자 차단, docs/design/usage-shared-workstation-axes.md §5.2 방향 A】
 *  WHERE에 `NOT EXISTS (SELECT 1 FROM usage_shared_workstations …)`를 추가했다. 라우트의 사전 검사
 *  (409 SHARED_WORKSTATION)와 이 커밋 사이에 다른 관리자가 그 값을 공용으로 등록하는 경합 창이
 *  있는데, 그 창을 **한 문장 안에서** 닫는다. 0행이 되면 원인이 두 가지(CAS 불일치 / 공용 등록)라
 *  호출부가 레지스트리를 다시 읽어 409를 재판정한다(admin-users.js).
 *  ⚠️ 이 UPDATE가 사용량 도메인 테이블(usage_shared_workstations)을 참조하는 이유는 **원자성**
 *     하나뿐이다 — 애플리케이션 계층 사전 검사만으로는 이 경합을 닫을 수 없다. 다른 곳에서
 *     users DAO가 사용량 스키마에 의존하게 만들지 말 것(읽기 경로는 여전히 완전히 분리돼 있다).
 *  ⚠️ 해제(employeeId === null)는 이 조건을 통과한다(`? IS NULL` 분기) — 잘못된 상태에서 빠져나오는
 *     경로를 절대 막지 않는다(레거시 탈출구).
 *  바인딩은 번호 파라미터(?NNN) 대신 같은 값을 반복 바인딩한다 — D1 드라이버의 번호 파라미터 지원에
 *  기대지 않고 순수 위치 파라미터만 쓴다. */
export function buildUpdateEmployeeIdStatement(db, id, employeeId, previousValue) {
  const now = new Date().toISOString()
  return db.prepare(
    `UPDATE users SET employee_id = ?, updated_at = ?
      WHERE id = ?
        AND employee_id IS ?
        AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM usage_shared_workstations w WHERE w.employee_id = ?))`
  ).bind(employeeId, now, id, previousValue, employeeId, employeeId)
}
