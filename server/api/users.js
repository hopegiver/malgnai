import { Hono } from 'hono'
import UsersDao from '../dao/users.js'
import { hashPassword } from '../utils/password.js'
import { authMiddleware } from '../middleware/auth.js'
import { badRequest, notFound, conflict, forbidden } from '../utils/response.js'

// 사용자 관리 CRUD — **관리자(role='admin')만** 허용. authMiddleware(JWT) 로 신원을
// 확인한 뒤 requireAdmin 으로 권한을 재확인한다. X-API-Key(인입 스크립트)는 사용자
// 관리에 관여하지 않는다.
// 비밀번호는 평문 저장 금지 — hashPassword(scrypt)로 hash/salt 만 저장한다.
const router = new Hono()

const MIN_PASSWORD_LEN = 8
const ROLES = ['admin', 'user']

/** authMiddleware 통과(JWT 검증) 후, 토큰 role 이 admin 인지 재확인. */
async function requireAdmin(c, next) {
  const me = c.get('user')
  if (!me || me.role !== 'admin') return forbidden(c, '관리자 권한이 필요합니다.')
  await next()
}

/** 외부로 내보낼 사용자 형태(민감 컬럼 제거). */
const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  role: u.role === 'admin' ? 'admin' : 'user',
  totp_enabled: !!u.totp_enabled,
  created_at: u.created_at,
  updated_at: u.updated_at,
})

const cleanUsername = (v) => (typeof v === 'string' ? v.trim() : '')
const normRole = (v) => (v === 'admin' ? 'admin' : 'user')

router.get('/', authMiddleware, requireAdmin, async (c) => {
  const dao = new UsersDao(c.env.DB)
  return c.json({ users: await dao.list() })
})

router.post('/', authMiddleware, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = cleanUsername(body.username)
  const password = typeof body.password === 'string' ? body.password : ''
  const role = body.role !== undefined ? normRole(body.role) : 'user'

  if (!username) return badRequest(c, '아이디를 입력하세요.')
  if (username.length > 120) return badRequest(c, '아이디가 너무 깁니다.')
  if (body.role !== undefined && !ROLES.includes(body.role)) return badRequest(c, '권한 값이 올바르지 않습니다.')
  if (password.length < MIN_PASSWORD_LEN) {
    return badRequest(c, `비밀번호는 최소 ${MIN_PASSWORD_LEN}자 이상이어야 합니다.`)
  }

  const dao = new UsersDao(c.env.DB)
  if (await dao.findByUsername(username)) return conflict(c, '이미 존재하는 아이디입니다.')

  const { hash, salt } = await hashPassword(password)
  let created
  try {
    created = await dao.create({ username, passwordHash: hash, passwordSalt: salt, role })
  } catch {
    // UNIQUE 경쟁 등.
    return conflict(c, '이미 존재하는 아이디입니다.')
  }
  return c.json({ user: publicUser(created) }, 201)
})

router.put('/:id', authMiddleware, requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const dao = new UsersDao(c.env.DB)

  const target = await dao.findById(id)
  if (!target) return notFound(c, '사용자를 찾을 수 없습니다.')

  // 아이디 변경(선택)
  if (body.username !== undefined) {
    const username = cleanUsername(body.username)
    if (!username) return badRequest(c, '아이디를 입력하세요.')
    if (username.length > 120) return badRequest(c, '아이디가 너무 깁니다.')
    if (username !== target.username) {
      const dup = await dao.findByUsername(username)
      if (dup) return conflict(c, '이미 존재하는 아이디입니다.')
      try {
        await dao.updateUsername(id, username)
      } catch {
        return conflict(c, '이미 존재하는 아이디입니다.')
      }
    }
  }

  // 권한(role) 변경(선택). 마지막 관리자를 강등하면 콘솔 잠금 위험 → 차단.
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) return badRequest(c, '권한 값이 올바르지 않습니다.')
    const role = normRole(body.role)
    if (target.role === 'admin' && role !== 'admin' && (await dao.countAdmins()) <= 1) {
      return badRequest(c, '마지막 관리자의 권한은 변경할 수 없습니다.')
    }
    await dao.updateRole(id, role)
  }

  // 비밀번호 재설정(선택, 빈 값이면 변경 안 함)
  if (body.password !== undefined && body.password !== '') {
    const password = String(body.password)
    if (password.length < MIN_PASSWORD_LEN) {
      return badRequest(c, `비밀번호는 최소 ${MIN_PASSWORD_LEN}자 이상이어야 합니다.`)
    }
    const { hash, salt } = await hashPassword(password)
    await dao.updatePasswordById(id, hash, salt)
  }

  const updated = await dao.findById(id)
  return c.json({ user: publicUser(updated) })
})

router.delete('/:id', authMiddleware, requireAdmin, async (c) => {
  const id = c.req.param('id')
  const dao = new UsersDao(c.env.DB)

  const target = await dao.findById(id)
  if (!target) return notFound(c, '사용자를 찾을 수 없습니다.')

  // 락아웃 방지: 자기 자신 삭제 금지 + 마지막 1명 + 마지막 관리자 삭제 금지.
  const me = c.get('user')
  if (me && me.sub === target.username) {
    return badRequest(c, '현재 로그인한 계정은 삭제할 수 없습니다.')
  }
  if ((await dao.count()) <= 1) {
    return badRequest(c, '마지막 사용자는 삭제할 수 없습니다.')
  }
  if (target.role === 'admin' && (await dao.countAdmins()) <= 1) {
    return badRequest(c, '마지막 관리자는 삭제할 수 없습니다.')
  }

  await dao.delete(id)
  return c.json({ deleted: true })
})

export default router
