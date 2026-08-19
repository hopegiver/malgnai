// 관리자 전용 카탈로그 동기화 트리거 — requireAdmin(server/middleware/jwt-auth.js)를 라우터
// 전체에 부착(backend-security-audit 규약 ② 역할 기반 인가 미들웨어), admin-users.js와 동일 패턴.
// 실제 동기화 로직은 server/lib/catalog-sync.js에 있고, 이 라우트와 server/index.js scheduled
// 핸들러(1일 1회 cron) 둘 다 그 함수 하나를 그대로 호출한다(중복 구현 방지).
import { Hono } from 'hono'
import { requireAdmin } from '../middleware/jwt-auth.js'
import { syncCatalog } from '../lib/catalog-sync.js'

const adminCatalog = new Hono()
adminCatalog.use('*', requireAdmin)

// POST /api/admin/catalog/sync — 즉시 동기화 실행, 결과 요약 반환(scanned/itemsUpserted/
// versionsCreated/parseFailures). GitHub 쪽 에러(fetch 실패/중복 slug)는 전역 onError로
// InternalError→500 / ConflictError→409 매핑된다.
adminCatalog.post('/sync', async (c) => {
  const result = await syncCatalog(c.env.DB)
  return c.json(result)
})

export default adminCatalog
