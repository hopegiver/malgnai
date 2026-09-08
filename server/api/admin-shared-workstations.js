// 관리자 전용 공용 워크스테이션 레지스트리 관리 — api.md §5.9.9.
// 설계 정본: docs/design/usage-shared-workstation-axes.md §5.3
//
// "이 employee_id 축은 개인이 아니라 여러 명이 함께 쓰는 공용 PC다"를 등록/해제하는 유일한 경로다.
// 자동 탐지·휴리스틱은 채택하지 않았고(설계 §2), 코드 상수 하드코딩도 하지 않는다 — 정본은
// 이 API로 편집되고 감사로그가 남는 D1 테이블(usage_shared_workstations, migrations/0022)뿐이다.
//
// ⚠️ server/api/usage.js에 얹지 않고 파일을 분리한 이유: 그 파일은 "GET 전용(+/sync 예외)" 규율을
//    주석으로 명시하고 있고, 여기서 쓰기 3개를 더하면 그 규율이 사실상 사라진다. 분리 비용은
//    server/index.js 한 줄이다.
// ⚠️ requireAdmin은 라우트별이 아니라 **라우터 전체**에 부착한다(admin-users.js와 같은 패턴) —
//    새 라우트를 추가할 때 인가를 빠뜨릴 수 있는 구멍을 구조적으로 없앤다.
import { Hono } from 'hono'
import * as sharedWorkstationsDao from '../dao/usage-shared-workstations.js'
import * as usersDao from '../dao/users.js'
import * as auditLogsDao from '../dao/audit-logs.js'
import { requireAdmin } from '../middleware/jwt-auth.js'
import { normalizeEmployeeIdInput, MAX_EMPLOYEE_ID_LENGTH, EMPLOYEE_ID_RE } from '../lib/usage-identity.js'

const LABEL_MAX_LENGTH = 100
const NOTE_MAX_LENGTH = 500

// 감사 액션은 **1개**로 통합하고 등록/해제는 metadata.op로 구분한다(설계 §5.4, migrations/0023).
// audit_logs.action이 CHECK 화이트리스트라 값을 늘릴 때마다 테이블 전체 재작성이 필요하기 때문이다
// (0009·0018·0021 선례). 이 도메인에 액션이 더 생겨도 metadata로 흡수한다.
const AUDIT_ACTION = 'shared_workstation.changed'
const AUDIT_TARGET_TYPE = 'shared_workstation'

const adminSharedWorkstations = new Hono()
adminSharedWorkstations.use('*', requireAdmin)

function toPublic(row) {
  return {
    employee_id: row.employee_id,
    label: row.label || null,
    note: row.note || null,
    registered_by: row.registered_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

/** 경로 파라미터 검증(4계층 중 라우트·정규화·형식) — normalizeEmployeeIdInput(기존 함수) 재사용:
 *  trim + toLowerCase + ^[a-z0-9._%+-]+$ + 길이 1..64. 경로 파라미터에는 "해제"라는 의미가 없으므로
 *  빈 값/null은 400이다.
 *  ⚠️ c.req.param()은 **퍼센트 디코드된 값**이다. EMPLOYEE_ID_RE가 '%'를 허용하므로 리터럴 '%'는
 *     URL에서 '%25'로 와야 한다 — 프런트는 반드시 encodeURIComponent()로 조립한다. */
function resolveEmployeeIdParam(c) {
  const raw = c.req.param('employeeId')
  const normalized = normalizeEmployeeIdInput(typeof raw === 'string' ? raw : '')
  if (normalized.error || !normalized.value) {
    return { error: `employee_id must match ${EMPLOYEE_ID_RE.source} and be at most ${MAX_EMPLOYEE_ID_LENGTH} characters` }
  }
  return { value: normalized.value }
}

/** label/note 본문 검증. 생략(undefined)·null은 둘 다 NULL로 저장, 빈 문자열도 NULL로 정규화한다
 *  (라벨이 ''인 행은 표시 규칙상 employee_id 폴백과 같은 뜻이라 두 표현을 남기지 않는다).
 *  ⚠️ 본문에서 employee_id를 받지 않는다 — 경로가 정본이며, 두 값이 어긋나는 상태를 만들지 않는다. */
function resolveTextField(value, fieldName, maxLength) {
  if (value === undefined || value === null) return { value: null }
  if (typeof value !== 'string') return { error: `${fieldName} must be a string or null` }
  const trimmed = value.trim()
  if (!trimmed) return { value: null }
  if (trimmed.length > maxLength) return { error: `${fieldName} must be at most ${maxLength} characters` }
  return { value: trimmed }
}

// D1/SQLite 드라이버는 제약 위반에 별도 에러 클래스를 주지 않아 메시지 문자열로 판별한다
// (admin-users.js의 isUniqueConstraintError와 같은 방식). 여기서는 PK 충돌(두 관리자가 같은 축을
// 동시에 등록, 설계 S5)을 잡아 "이미 존재"로 수렴시킨다.
function isConstraintError(err) {
  return !!err && typeof err.message === 'string' &&
    (err.message.includes('UNIQUE constraint failed') || err.message.includes('PRIMARY KEY'))
}

function conflictResponse(c, holder) {
  return c.json({
    error: {
      code: 'CONFLICT',
      message: 'employee_id is currently linked to a member account; unlink it first',
      details: {
        conflict_user_id: holder ? holder.id : null,
        conflict_email: holder ? holder.email : null
      }
    }
  }, 409)
}

// GET /api/admin/usage/shared-workstations — 전체 목록(employee_id ASC).
// 페이지네이션 없음(수십 행 규모, GET /api/admin/users와 동일 판단).
adminSharedWorkstations.get('/', async (c) => {
  const rows = await sharedWorkstationsDao.listAll(c.env.DB)
  return c.json({ data: rows.map(toPublic) })
})

// PUT /api/admin/usage/shared-workstations/:employeeId — 등록(201) 또는 라벨·메모 갱신(200). 멱등.
// 요청 본문: { label?: string|null, note?: string|null }
//
// 역방향 가드(설계 §5.2 방향 B) — 어떤 회원이 그 값을 users.employee_id로 보유 중이면 409 CONFLICT.
// "등록됨 + 회원 연결됨"은 화면 어디서도 좋은 표현이 없는 상태라(회원 행은 0을 표시하고 공용 행은
// 따로 뜬다) 아예 만들지 않는 편이 읽기 경로 전부에 설명 로직을 붙이는 것보다 싸다. 사전 검사와
// 커밋 사이의 경합까지 조건부 INSERT 한 문장으로 원자 차단한다.
adminSharedWorkstations.put('/:employeeId', async (c) => {
  const param = resolveEmployeeIdParam(c)
  if (param.error) return c.json({ error: { code: 'VALIDATION_ERROR', message: param.error } }, 400)
  const employeeId = param.value

  const body = await c.req.json().catch(() => ({}))
  const label = resolveTextField(body ? body.label : null, 'label', LABEL_MAX_LENGTH)
  if (label.error) return c.json({ error: { code: 'VALIDATION_ERROR', message: label.error } }, 400)
  const note = resolveTextField(body ? body.note : null, 'note', NOTE_MAX_LENGTH)
  if (note.error) return c.json({ error: { code: 'VALIDATION_ERROR', message: note.error } }, 400)

  const now = new Date().toISOString()
  const existing = await sharedWorkstationsDao.findById(c.env.DB, employeeId)

  // 이미 등록된 축 → 라벨·메모 갱신. **감사로그를 쓰지 않는다** — 라벨은 귀속을 바꾸지 않는 표시용
  // 텍스트이고, 감사 대상은 귀속을 바꾸는 변경(등록/해제)으로 한정한다(기존 방침 계승).
  if (existing) {
    await sharedWorkstationsDao.updateLabel(c.env.DB, employeeId, { label: label.value, note: note.value, now })
    const updated = await sharedWorkstationsDao.findById(c.env.DB, employeeId)
    return c.json({ shared_workstation: toPublic(updated), created: false })
  }

  const insertStmt = sharedWorkstationsDao.buildInsertIfUnheldStatement(c.env.DB, {
    employeeId, label: label.value, note: note.value, registeredBy: c.get('userId'), now
  })
  const { stmt: auditStmt } = auditLogsDao.buildRecordStatementIfPrecedingChanged(c.env.DB, {
    actorUserId: c.get('userId'),
    action: AUDIT_ACTION,
    targetType: AUDIT_TARGET_TYPE,
    targetId: employeeId,
    metadata: { op: 'registered', label: label.value, note: note.value }
  })

  let insertResult
  try {
    // 원자 커밋 — 조건부 INSERT가 0행이면 감사 INSERT도 `WHERE (SELECT changes()) > 0`으로 함께
    // no-op이 된다(--local 실측 확인). "일어나지 않은 등록"이 감사로그에 남지 않는다.
    ;[insertResult] = await c.env.DB.batch([insertStmt, auditStmt])
  } catch (err) {
    if (isConstraintError(err)) {
      // S5 — 두 관리자가 같은 축을 동시에 등록. 늦은 쪽은 PK 충돌로 실패하지만 결론은 같으므로
      // "이미 존재"(라벨 갱신)로 수렴시킨다. 조용한 덮어쓰기가 아니라 같은 결론이라 무해하다.
      const raced = await sharedWorkstationsDao.findById(c.env.DB, employeeId)
      if (raced) {
        await sharedWorkstationsDao.updateLabel(c.env.DB, employeeId, { label: label.value, note: note.value, now })
        const updated = await sharedWorkstationsDao.findById(c.env.DB, employeeId)
        return c.json({ shared_workstation: toPublic(updated), created: false })
      }
    }
    throw err
  }

  if (insertResult.meta.changes === 0) {
    // 조건부 INSERT의 NOT EXISTS가 걸렸다 = 어떤 회원이 그 값을 보유 중이다(선해제 요구).
    const holder = await usersDao.findByEmployeeId(c.env.DB, employeeId)
    return conflictResponse(c, holder)
  }

  const created = await sharedWorkstationsDao.findById(c.env.DB, employeeId)
  return c.json({ shared_workstation: toPublic(created), created: true }, 201)
})

// DELETE /api/admin/usage/shared-workstations/:employeeId — 등록 해제. 없으면 404.
// 해제하면 그 축의 사용량은 다음 요청부터 다시 개인 축(emp:)으로 되돌아간다(연결된 회원이 없으면
// prometheus_only 행). 총합은 어느 쪽이든 변하지 않는다 — 귀속만 이동한다.
adminSharedWorkstations.delete('/:employeeId', async (c) => {
  const param = resolveEmployeeIdParam(c)
  if (param.error) return c.json({ error: { code: 'VALIDATION_ERROR', message: param.error } }, 400)
  const employeeId = param.value

  const existing = await sharedWorkstationsDao.findById(c.env.DB, employeeId)
  if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'shared workstation not found' } }, 404)

  const deleteStmt = sharedWorkstationsDao.buildDeleteStatement(c.env.DB, employeeId)
  const { stmt: auditStmt } = auditLogsDao.buildRecordStatementIfPrecedingChanged(c.env.DB, {
    actorUserId: c.get('userId'),
    action: AUDIT_ACTION,
    targetType: AUDIT_TARGET_TYPE,
    targetId: employeeId,
    metadata: { op: 'unregistered', label: existing.label || null, note: existing.note || null }
  })

  const [deleteResult] = await c.env.DB.batch([deleteStmt, auditStmt])
  // 그 사이 다른 관리자가 이미 해제했다 — 감사 INSERT도 함께 no-op이므로 없던 해제가 기록되지 않는다.
  if (deleteResult.meta.changes === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'shared workstation not found' } }, 404)
  }

  return c.json({ employee_id: employeeId, deleted: true })
})

export default adminSharedWorkstations
