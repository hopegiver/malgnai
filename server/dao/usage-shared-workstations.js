// usage_shared_workstations 테이블 DAO — "이 employee_id 축은 개인이 아니라 여러 명이 함께 쓰는
// 공용 워크스테이션(공용 PC)이다"를 관리자가 명시 등록하는 레지스트리(migrations/0022).
// 설계 정본: docs/design/usage-shared-workstation-axes.md
//
// ⚠️ 판정 정본은 이 테이블뿐이다 — 자동 탐지/휴리스틱은 채택하지 않았다(설계 §2: 관측되는
//    user_email 10개가 전부 그룹 계정이라 어떤 자동 신호도 실측 3건을 못 잡고 정상 직원을 오탐한다).
// ⚠️ fail-closed — 이 DAO의 조회가 실패하면 호출부는 예외를 그대로 전파해 5xx로 떨어뜨린다.
//    빈 Map으로 계속 진행하면 공용 축이 조용히 개인 축으로 되살아나 오귀속이 발생한다(설계 S10).
// ⚠️ 판정 로직 자체(순수 함수)는 server/lib/usage-identity.js에 있다 — 이 파일은 데이터 로드만
//    담당하고, 결합은 병합 계층(usage-prom.js)·라우트가 한다.

const SELECT_COLUMNS = 'employee_id, label, note, registered_by, created_at, updated_at'

/** 전체 목록(employee_id ASC). 페이지네이션 없음 — 수십 행 규모(GET /api/admin/users와 동일 판단). */
export async function listAll(db) {
  const { results } = await db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM usage_shared_workstations ORDER BY employee_id ASC`
  ).all()
  return results
}

/** 읽기 경로(관리자 목록 병합)용 — Map<employee_id, row>. 값이 row인 이유: 표시 이름에 label이
 *  필요하기 때문이다(Set이 아니라 Map, 설계 §4.1). */
export async function loadMap(db) {
  const rows = await listAll(db)
  const map = new Map()
  for (const row of rows) map.set(row.employee_id, row)
  return map
}

/** PK 단건 조회 — /me·드릴다운·관리자 편집 가드가 쓴다. 전건 스캔(loadMap) 대신 이 경로를 쓰는
 *  이유: 그 세 지점은 "이 하나의 값이 공용인가"만 알면 되고, 레지스트리가 커져도 비용이 고정이다. */
export async function findById(db, employeeId) {
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM usage_shared_workstations WHERE employee_id = ?`)
    .bind(employeeId).first()
}

/** 조건부 INSERT statement(설계 §5.2 방향 B) — "어떤 회원이 그 값을 employee_id로 보유 중이면
 *  등록하지 않는다"를 **SQL 한 문장 안에서** 판정해 사전 확인과 커밋 사이의 경합 창을 없앤다.
 *  실행(.run())은 하지 않는다 — 호출부가 조건부 감사 INSERT와 함께 db.batch()로 원자 커밋한다.
 *  meta.changes === 0 이면 "보유자가 있어 등록되지 않았다"는 뜻이고, 같은 batch의 감사 INSERT도
 *  buildRecordStatementIfPrecedingChanged의 `WHERE (SELECT changes()) > 0`으로 함께 no-op이 된다
 *  (--local 실측 확인: 조건부 INSERT가 0행이면 뒤따르는 조건부 감사 INSERT도 실행되지 않는다).
 *  ⚠️ PK 충돌(이미 등록된 값)은 이 문장이 막지 않는다 — 호출부가 findById로 먼저 분기한다(§5.3). */
export function buildInsertIfUnheldStatement(db, { employeeId, label, note, registeredBy, now }) {
  return db.prepare(
    `INSERT INTO usage_shared_workstations (employee_id, label, note, registered_by, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.employee_id = ?)`
  ).bind(employeeId, label ?? null, note ?? null, registeredBy || null, now, now, employeeId)
}

/** 라벨·메모 갱신(이미 등록된 축) — 감사로그를 쓰지 않는다. 라벨은 귀속을 바꾸지 않는 표시용
 *  텍스트이고, 감사 대상은 귀속을 바꾸는 변경(등록/해제)으로 한정한다(설계 §5.3). */
export async function updateLabel(db, employeeId, { label, note, now }) {
  const result = await db.prepare(
    'UPDATE usage_shared_workstations SET label = ?, note = ?, updated_at = ? WHERE employee_id = ?'
  ).bind(label ?? null, note ?? null, now, employeeId).run()
  return result
}

/** 등록 해제 statement — 조건부 감사 INSERT와 함께 db.batch()로 원자 커밋한다(호출부가 실행).
 *  meta.changes === 0 이면 그 사이 다른 관리자가 이미 해제한 것이므로 404로 응답한다. */
export function buildDeleteStatement(db, employeeId) {
  return db.prepare('DELETE FROM usage_shared_workstations WHERE employee_id = ?').bind(employeeId)
}
