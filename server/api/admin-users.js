// 관리자 전용 사용자 관리 — api.md §5.6. requireAdmin(server/middleware/jwt-auth.js)를 라우터
// 전체에 부착(backend-security-audit 규약 ② 역할 기반 인가 미들웨어). password_hash는 어떤 응답
// 필드에도 포함하지 않는다.
//
// PUT /:id/employee-id(§5) — 사용량 연동 아이디 편집. docs/design/usage-employee-identity-linking.md
// 정본. Sensitive 등급(식별자 재연결 = "A의 사용량을 B에게 붙이는" 조작) — UPDATE와 감사로그를
// db.batch()로 원자 커밋하고, 다른 사용자가 보유 중인 값은 409로 거절해 무언의 이전을 막는다(§4.4 S2).
import { Hono } from 'hono'
import * as usersDao from '../dao/users.js'
import * as auditLogsDao from '../dao/audit-logs.js'
import { hashPassword, generateTempPassword } from '../lib/tokens.js'
import { requireAdmin } from '../middleware/jwt-auth.js'
import { normalizeEmployeeIdInput, employeeIdFromEmail } from '../lib/usage-identity.js'

const ROLES = ['employee', 'administrator']
const STATUSES = ['active', 'disabled']
const NAME_MAX_LENGTH = 100
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const adminUsers = new Hono()
adminUsers.use('*', requireAdmin)

function toPublicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status, employee_id: user.employee_id || null, created_at: user.created_at }
}

// D1 UNIQUE 위반 메시지 판별(§5.4 L5 — 사전 확인 통과 후 커밋 시점 경합). D1/SQLite 드라이버는
// "UNIQUE constraint failed: users.employee_id: SQLITE_CONSTRAINT ..." 형태의 Error를 던진다 —
// 별도 에러 클래스가 없어 메시지 문자열로 판별한다(로컬 --local 실기동으로 실측한 형태, §완료판정 3).
function isUniqueConstraintError(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed')
}

// GET /api/admin/users — 전체 사용자 목록(password_hash 제외).
adminUsers.get('/', async (c) => {
  const list = await usersDao.listAll(c.env.DB)
  return c.json({ data: list })
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

  // §5.8 — 신규 계정 기본값. 이메일 로컬파트가 유효하고 아직 아무도 보유하지 않았으면 그 값으로
  // 채운다(폴백을 읽기에서 쓰기로 옮긴 결정의 반대쪽 짝, §3.1). 유효하지 않거나 이미 쓰이면 NULL +
  // warnings로 계정 생성 자체는 그대로 성공시킨다(201) — 연동은 나중에 관리자 편집 API로 채울 수 있다.
  const warnings = []
  let employeeId = null
  const candidateId = employeeIdFromEmail(email)
  if (!candidateId) {
    warnings.push('employee_id_underivable')
  } else {
    const holder = await usersDao.findByEmployeeId(c.env.DB, candidateId)
    if (holder) {
      warnings.push('employee_id_taken')
    } else {
      employeeId = candidateId
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
  const updateStmt = usersDao.buildUpdateEmployeeIdStatement(c.env.DB, id, newValue)
  const { stmt: auditStmt } = auditLogsDao.buildRecordStatement(c.env.DB, {
    actorUserId: c.get('userId'),
    action: 'user.employee_id_changed',
    targetType: 'user',
    targetId: id,
    metadata: { before: previousValue, after: newValue, target_email: target.email, local_part_mismatch: localPartMismatch }
  })

  try {
    // §5.5 원자 커밋 — UPDATE와 감사 INSERT를 하나의 batch로. 어느 한쪽만 성공하는 상태(L5·L6)를
    // 만들지 않는다: batch 전체가 실패하면(경합으로 인한 UNIQUE 위반 포함) 둘 다 롤백된다.
    await c.env.DB.batch([updateStmt, auditStmt])
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

  const warnings = []
  if (localPartMismatch) warnings.push('local_part_mismatch')
  if (previousValue !== null) warnings.push('overwrote_existing_link')

  const updated = await usersDao.findById(c.env.DB, id)
  return c.json({ user: toPublicUser(updated), previous_employee_id: previousValue, changed: true, warnings })
})

export default adminUsers
