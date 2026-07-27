// 관리자 전용 사용자 관리 — api.md §5.6. requireAdmin(server/middleware/jwt-auth.js)를 라우터
// 전체에 부착(backend-security-audit 규약 ② 역할 기반 인가 미들웨어). password_hash는 어떤 응답
// 필드에도 포함하지 않는다.
import { Hono } from 'hono'
import * as usersDao from '../dao/users.js'
import * as auditLogsDao from '../dao/audit-logs.js'
import { hashPassword, generateTempPassword } from '../lib/tokens.js'
import { requireAdmin } from '../middleware/jwt-auth.js'

const ROLES = ['employee', 'administrator']
const STATUSES = ['active', 'disabled']
const NAME_MAX_LENGTH = 100
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const adminUsers = new Hono()
adminUsers.use('*', requireAdmin)

function toPublicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status, created_at: user.created_at }
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

  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)
  const created = await usersDao.insert(c.env.DB, { email, name, passwordHash, role })

  return c.json({ ...toPublicUser(created), temporary_password: tempPassword }, 201)
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

export default adminUsers
