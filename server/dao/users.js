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
 *  또는 그 반대의 절반 커밋이 생기지 않는다(L5·L6). */
export function buildUpdateEmployeeIdStatement(db, id, employeeId) {
  const now = new Date().toISOString()
  return db.prepare('UPDATE users SET employee_id = ?, updated_at = ? WHERE id = ?').bind(employeeId, now, id)
}
