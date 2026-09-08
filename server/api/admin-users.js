// 관리자 전용 사용자 관리 — api.md §5.6. requireAdmin(server/middleware/jwt-auth.js)를 라우터
// 전체에 부착(backend-security-audit 규약 ② 역할 기반 인가 미들웨어). password_hash는 어떤 응답
// 필드에도 포함하지 않는다.
//
// PUT /:id/employee-id(§5) — 사용량 연동 아이디 편집. docs/design/usage-employee-identity-linking.md
// 정본. Sensitive 등급(식별자 재연결 = "A의 사용량을 B에게 붙이는" 조작) — UPDATE와 감사로그를
// db.batch()로 원자 커밋하고, 다른 사용자가 보유 중인 값은 409로 거절해 무언의 이전을 막는다(§4.4 S2).
import { Hono } from 'hono'
import * as usersDao from '../dao/users.js'
import * as projectsDao from '../dao/projects.js'
import * as auditLogsDao from '../dao/audit-logs.js'
import * as sharedWorkstationsDao from '../dao/usage-shared-workstations.js'
import { hashPassword, generateTempPassword } from '../lib/tokens.js'
import { requireAdmin } from '../middleware/jwt-auth.js'
import { normalizeEmployeeIdInput, employeeIdFromEmail } from '../lib/usage-identity.js'

const ROLES = ['employee', 'administrator']
const STATUSES = ['active', 'disabled']
const NAME_MAX_LENGTH = 100
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const adminUsers = new Hono()
adminUsers.use('*', requireAdmin)

// projectCount 생략 시 0 — POST(신규 계정)는 항상 프로젝트 0개라 정확하고, PATCH/PUT employee-id는
// 이 필드를 소비하지 않는 화면 갱신 경로라 조회를 추가하지 않는다(GET / 만 실제 집계값을 채운다).
function toPublicUser(user, projectCount = 0) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status, employee_id: user.employee_id || null, created_at: user.created_at, project_count: projectCount }
}

// D1 UNIQUE 위반 메시지 판별(§5.4 L5 — 사전 확인 통과 후 커밋 시점 경합). D1/SQLite 드라이버는
// "UNIQUE constraint failed: users.employee_id: SQLITE_CONSTRAINT ..." 형태의 Error를 던진다 —
// 별도 에러 클래스가 없어 메시지 문자열로 판별한다(로컬 --local 실기동으로 실측한 형태, §완료판정 3).
function isUniqueConstraintError(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed')
}

// GET /api/admin/users — 전체 사용자 목록(password_hash 제외). project_count(정수, 프로젝트가
// 없으면 0)는 projects 테이블을 사용자별로 GROUP BY 집계한 뒤 메모리에서 병합한다(N+1 방지).
adminUsers.get('/', async (c) => {
  const [list, projectCounts] = await Promise.all([
    usersDao.listAll(c.env.DB),
    projectsDao.countAllByUser(c.env.DB)
  ])
  const data = list.map((user) => toPublicUser(user, projectCounts.get(user.id) || 0))
  return c.json({ data })
})

// POST /api/admin/users — { email, name, role }로 신규 계정 생성. 시스템이 임시 비밀번호를
// 랜덤 생성해 해시 저장하고, 응답에 평문 임시 비밀번호를 1회만 포함(관리자가 새 직원에게 전달,
// 재조회 불가 — 저장은 해시만).
adminUsers.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const role = body.role

  if (!email || !EMAIL_RE.test(email)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'a valid email is required' } }, 400)
  }
  if (!name) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400)
  }
  if (name.length > NAME_MAX_LENGTH) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: `name must be at most ${NAME_MAX_LENGTH} characters` } }, 400)
  }
  if (!ROLES.includes(role)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: `role must be one of ${ROLES.join(', ')}` } }, 400)
  }

  const existing = await usersDao.findByEmail(c.env.DB, email)
  if (existing) {
    return c.json({ error: { code: 'CONFLICT', message: 'email already in use' } }, 409)
  }

  // M-4 수정(리뷰 2026-09-07) — §5.8의 "로컬파트 자동 부여"를 껐다. "users 중 아무도 보유하지
  // 않았다"만으로는 주인 없는 관측 축(Prometheus에서 이미 관측 중인데 어떤 허브 계정에도 안 걸린
  // employee_id — PM 실측: malgn/public/claude 3개가 실제로 이 상태)과 "정말 아무도 안 쓰는 값"을
  // 구분할 수 없다. 여기서 자동 부여하면 새 계정이 그 관측 축의 과거 사용량을 조용히 물려받는데,
  // 이 라우트는 감사로그도 쓰지 않는다(§2.4 "판단은 사람이 API로 한다" 원칙 위반). 계정 생성은
  // 그대로 성공시키되(201) employee_id는 항상 NULL로 두고, 후보값은 warnings로만 안내한다 — 실제
  // 연결은 관리자가 PUT /api/admin/users/:id/employee-id로 명시 수행해야 하고, 그 경로만 감사로그를
  // 남긴다(§5.5). 프런트(app/pages/admin/users.vue submitCreate)는 이 응답의 employee_id/warnings를
  // 읽지 않으므로(편집 모달의 제안값은 이메일에서 클라이언트가 별도 계산) 계약 변경이 아니다.
  const warnings = []
  const employeeId = null
  const candidateId = employeeIdFromEmail(email)
  if (!candidateId) {
    warnings.push('employee_id_underivable')
  } else {
    const holder = await usersDao.findByEmployeeId(c.env.DB, candidateId)
    if (holder) {
      warnings.push('employee_id_taken') // 참고 정보 — 이미 다른 사용자가 보유. 자동 연결은 하지 않는다.
    } else {
      warnings.push('employee_id_not_auto_linked') // 후보값은 있으나 자동 부여하지 않음 — 관리자가 PUT으로 명시 연결
    }
  }

  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)
  const created = await usersDao.insert(c.env.DB, { email, name, passwordHash, role, mustChangePassword: true, employeeId })

  return c.json({ ...toPublicUser(created), temporary_password: tempPassword, warnings }, 201)
})

// PATCH /api/admin/users/:id — { name?, role?, status? } 부분 갱신. 마지막 남은 활성
// administrator를 강등(role→employee)하거나 비활성화(status→disabled)하는 시도는 차단
// (관리자 0명 상태 방지). role/status 변경 시 audit_logs('user.role_changed') 기록.
adminUsers.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const target = await usersDao.findById(c.env.DB, id)
  if (!target) return c.json({ error: { code: 'NOT_FOUND', message: 'user not found' } }, 404)

  const body = await c.req.json().catch(() => ({}))
  const fields = {}

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name must not be empty' } }, 400)
    if (name.length > NAME_MAX_LENGTH) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: `name must be at most ${NAME_MAX_LENGTH} characters` } }, 400)
    }
    fields.name = name
  }
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: `role must be one of ${ROLES.join(', ')}` } }, 400)
    }
    fields.role = body.role
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: `status must be one of ${STATUSES.join(', ')}` } }, 400)
    }
    fields.status = body.status
  }

  if (!Object.keys(fields).length) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'no updatable fields provided' } }, 400)
  }

  // 마지막 남은 활성 관리자 보호: 이 갱신으로 "활성 administrator" 집합에서 target이 빠지게
  // 되는 경우에만 카운트를 확인한다(불필요한 매 요청 COUNT 방지).
  const finalRole = fields.role !== undefined ? fields.role : target.role
  const finalStatus = fields.status !== undefined ? fields.status : target.status
  const wasActiveAdmin = target.role === 'administrator' && target.status === 'active'
  const staysActiveAdmin = finalRole === 'administrator' && finalStatus === 'active'
  if (wasActiveAdmin && !staysActiveAdmin) {
    const activeAdminCount = await usersDao.countActiveAdmins(c.env.DB)
    if (activeAdminCount <= 1) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'cannot remove the last active administrator' } }, 400)
    }
  }

  await usersDao.updateRoleStatus(c.env.DB, id, fields)

  if (fields.role !== undefined || fields.status !== undefined) {
    await auditLogsDao.record(c.env.DB, {
      actorUserId: c.get('userId'),
      action: 'user.role_changed',
      targetType: 'user',
      targetId: id,
      metadata: {
        before: { role: target.role, status: target.status },
        after: { role: finalRole, status: finalStatus }
      }
    })
  }

  const updated = await usersDao.findById(c.env.DB, id)
  return c.json(toPublicUser(updated))
})

// PUT /api/admin/users/:id/employee-id — { employee_id: "<value>" | null } (§5). 값의 전면 교체,
// 멱등. requireAdmin이 라우터 전체에 이미 붙어 있다(§5.1 "administrator 전용" — 그 외 403).
// 본인 행 편집도 허용한다 — 관리자는 이미 드릴다운으로 전원 조회가 가능해 권한 상승이 아니다(§5.1).
adminUsers.put('/:id/employee-id', async (c) => {
  const id = c.req.param('id')
  const target = await usersDao.findById(c.env.DB, id)
  if (!target) return c.json({ error: { code: 'NOT_FOUND', message: 'user not found' } }, 404)

  const body = await c.req.json().catch(() => undefined)
  // employee_id 키가 없으면(undefined) 400 — null(해제 의도)과 누락(실수)을 구분한다(§5.2).
  if (!body || !Object.hasOwn(body, 'employee_id')) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'employee_id is required (send null to unlink)' } }, 400)
  }

  const normalized = normalizeEmployeeIdInput(body.employee_id)
  if (normalized.error) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: normalized.error } }, 400)
  }
  const newValue = normalized.value // string(정규화됨) 또는 null
  const previousValue = target.employee_id || null

  // 같은 값 재지정(no-op) — 200 + changed:false, 감사로그는 쓰지 않는다(§5.4 노이즈 방지).
  if (newValue === previousValue) {
    return c.json({ user: toPublicUser(target), previous_employee_id: previousValue, changed: false, warnings: [] })
  }

  // 【공용 워크스테이션 차단, docs/design/usage-shared-workstation-axes.md §5.1】
  // 등록된 공용 축(여러 명이 함께 쓰는 PC)을 개인 계정에 연결하면 그 그룹 전체의 사용량이 한 사람의
  // 개인 사용량으로 표시된다 — 이번 기능 전환의 목적에 정면으로 반하는 조작이라 409로 막는다.
  // ⚠️ 강제 우회(force/confirm)를 만들지 않는다: 같은 라우트의 보유자 409가 이미 "선해제 요구"를
  //    택했고, force는 이 안전장치 전체가 무너지는 단일 지점이 된다. 정당한 연결이 필요하면 먼저
  //    레지스트리에서 해제한다(감사로그가 남는 2회 조작).
  // ⚠️ 검사 순서 — 보유자 검사(아래)보다 **먼저** 본다. 두 조건이 동시에 성립해도 응답은 항상
  //    SHARED_WORKSTATION으로 결정적이다(관리자가 먼저 해야 할 조치가 "공용 등록 해제"이기 때문).
  // ⚠️ 해제(newValue === null)는 이 검사를 아예 타지 않는다 — 잘못된 상태에서 빠져나오는 경로를
  //    등록 여부와 무관하게 항상 열어 둔다(레거시 탈출구).
  // ⚠️ fail-open 금지 — 레지스트리 조회가 실패하면 예외를 그대로 전파해 5xx로 떨어뜨린다(try/catch로
  //    삼켜 "못 읽었으니 통과"시키면 이 안전장치가 장애 시 자동으로 꺼진다).
  if (newValue !== null) {
    const shared = await sharedWorkstationsDao.findById(c.env.DB, newValue)
    if (shared) {
      return c.json({
        error: {
          code: 'SHARED_WORKSTATION',
          message: 'employee_id is registered as a shared workstation and cannot be linked to a member account',
          details: {
            employee_id: shared.employee_id,
            label: shared.label || null,
            registered_at: shared.created_at,
            registered_by_user_id: shared.registered_by || null
          }
        }
      }, 409)
    }
  }

  // 사전 확인(§5.4) — 다른 사용자가 이미 그 값을 보유하면 409, 자동 이전하지 않는다. 이 확인을
  // 통과했더라도 두 관리자의 동시 요청이 있으면 아래 db.batch()의 UNIQUE 제약이 최종 심판자다.
  if (newValue !== null) {
    const holder = await usersDao.findByEmployeeId(c.env.DB, newValue)
    if (holder && holder.id !== id) {
      return c.json({
        error: {
          code: 'CONFLICT',
          message: 'employee_id is already linked to another user',
          details: { conflict_user_id: holder.id, conflict_email: holder.email }
        }
      }, 409)
    }
  }

  const localPartMismatch = newValue !== null && newValue !== employeeIdFromEmail(target.email)
  // M-2 수정(리뷰 2026-09-07) — updateStmt에 서버측 CAS(previousValue) 추가, auditStmt는 그 CAS가
  // 실제로 행을 바꿨을 때만 실행되는 조건부 버전으로 교체(dao/users.js·dao/audit-logs.js 주석 참고).
  const updateStmt = usersDao.buildUpdateEmployeeIdStatement(c.env.DB, id, newValue, previousValue)
  const { stmt: auditStmt } = auditLogsDao.buildRecordStatementIfPrecedingChanged(c.env.DB, {
    actorUserId: c.get('userId'),
    action: 'user.employee_id_changed',
    targetType: 'user',
    targetId: id,
    metadata: { before: previousValue, after: newValue, target_email: target.email, local_part_mismatch: localPartMismatch }
  })

  let updateResult
  try {
    // §5.5 원자 커밋 — UPDATE와 감사 INSERT를 하나의 batch로. 어느 한쪽만 성공하는 상태(L5·L6)를
    // 만들지 않는다: batch 전체가 실패하면(경합으로 인한 UNIQUE 위반 포함) 둘 다 롤백된다.
    ;[updateResult] = await c.env.DB.batch([updateStmt, auditStmt])
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // 두 관리자가 같은 값을 동시에 다른 사용자에게 지정(§5.4 L4) — 늦은 쪽만 409, 조용한 덮어쓰기 없음.
      const holder = await usersDao.findByEmployeeId(c.env.DB, newValue)
      return c.json({
        error: {
          code: 'CONFLICT',
          message: 'employee_id is already linked to another user',
          details: { conflict_user_id: holder ? holder.id : null, conflict_email: holder ? holder.email : null }
        }
      }, 409)
    }
    throw err
  }

  // M-2 — 사전 확인(위 findByEmployeeId)을 통과한 뒤에도 다른 관리자가 이 target을 먼저 바꿨으면
  // CAS(WHERE employee_id IS previousValue)가 걸려 0행이다. 이때 auditStmt도 이미 no-op이었으므로
  // (buildRecordStatementIfPrecedingChanged) 여기서 그대로 반환해도 잘못된 감사로그가 남지 않는다 —
  // 클라이언트는 최신 상태를 다시 읽고 재시도해야 한다(§5.4 T-2, 낙관적 잠금이 아니라 서버측 CAS).
  if (updateResult.meta.changes === 0) {
    // 0행의 원인이 두 가지다(§5.2 방향 A) — ① CAS 불일치(다른 관리자가 이 target을 먼저 바꿈)
    // ② 사전 검사 통과 후 그 값이 공용 워크스테이션으로 등록됨(UPDATE WHERE의 NOT EXISTS가 걸림).
    // 레지스트리를 다시 읽어 재판정한다 — 관리자에게 "재시도하라"(STALE_STATE)와 "먼저 공용 등록을
    // 해제하라"(SHARED_WORKSTATION)는 완전히 다른 조치이기 때문이다. 감사로그는 조건부 INSERT라
    // 이미 함께 no-op이므로 일어나지 않은 변경이 기록되지 않는다.
    const shared = newValue !== null ? await sharedWorkstationsDao.findById(c.env.DB, newValue) : null
    if (shared) {
      return c.json({
        error: {
          code: 'SHARED_WORKSTATION',
          message: 'employee_id is registered as a shared workstation and cannot be linked to a member account',
          details: {
            employee_id: shared.employee_id,
            label: shared.label || null,
            registered_at: shared.created_at,
            registered_by_user_id: shared.registered_by || null
          }
        }
      }, 409)
    }
    return c.json({
      error: { code: 'STALE_STATE', message: 'employee_id was changed by another request in the meantime, please retry' }
    }, 409)
  }

  const warnings = []
  if (localPartMismatch) warnings.push('local_part_mismatch')
  if (previousValue !== null) warnings.push('overwrote_existing_link')

  const updated = await usersDao.findById(c.env.DB, id)
  return c.json({ user: toPublicUser(updated), previous_employee_id: previousValue, changed: true, warnings })
})

export default adminUsers
