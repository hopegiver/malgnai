import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import { forbidden } from '../utils/response.js'
import { logActivity } from '../lib/activity-log.js'
import { isSuperAdmin } from '../lib/roles.js'

// 시스템 레벨 운영 액션(현재는 서버 재시작 1종) — **최고관리자(role='super_admin')만** 허용.
// LaunchAgent(com.malgnai.server, KeepAlive=true)가 프로세스 종료를 감지해 즉시
// 재기동하므로, 서버가 직접 할 일은 "정상 종료"뿐이다.
const router = new Hono()

async function requireSuperAdmin(c, next) {
  const me = c.get('user')
  if (!me || !isSuperAdmin(me.role)) return forbidden(c, '최고관리자 권한이 필요합니다.')
  await next()
}

router.get('/vapid-public-key', (c) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  if (!publicKey) {
    return c.json({ error: 'VAPID public key not configured' }, 500)
  }
  return c.json({ publicKey })
})

router.post('/restart', authMiddleware, requireSuperAdmin, async (c) => {
  const me = c.get('user')
  logActivity(c.env.DB, {
    agent_name: 'system',
    action: 'server_restart',
    detail: `${me?.sub || 'admin'} 요청으로 서버 재시작`,
    level: 'audit',
    category: 'system',
  })
  // 응답을 먼저 내려보낸 뒤 종료 — LaunchAgent KeepAlive 가 자동으로 재기동한다.
  setTimeout(() => process.exit(0), 300)
  return c.json({ ok: true, message: '서버를 재시작합니다.' })
})

export default router
