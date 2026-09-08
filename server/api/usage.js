// 사용량/세션 조회 라우트 — api.md §5.5(2단계). JWT 인증(POST /api/sessions만 예외, server/api/sessions.js
// 참고). 쓰기는 POST /api/sessions 하나뿐이라 이 파일은 GET 전용(단, /admin/usage/sync는 예외 — §18.7).
//
// GET /api/admin/usage/* 3개 라우트는 D1이 아니라 외부 Prometheus를 정본으로 삼는다(rev.2 하이브리드
// — docs/design/usage-prometheus-realtime.md 정본, architecture.md §0 결정29 개정). /summary·/users는
// 완결일=D1 롤업 캐시(usage_prom_daily, Cron 적재) + 오늘=라이브 하이브리드, /users/:id는 전 구간
// 라이브 그대로(§0.1 C9). usageDailyDao(usage_daily, 자체수집)는 이 파일 어디서도 import하지 않는다 —
// 관리자 라우트뿐 아니라 /me도 자체수집 오염과 완전히 분리됐다(§17.2b 경계가 본인 축까지 확장됨).
// /projects/:id(본인 축)는 sessions 테이블을 직접 재집계하므로(§0 결정25) 애초에 usageDailyDao와 무관.
//
// ⚠️ 식별 축 전환(docs/design/usage-employee-identity-linking.md, PM 확정 2026-09-07) — 사용량의
// 1차 키는 employee_id(개인)이고, 그 값의 정본은 이제 D1 users.employee_id 컬럼이다(이메일 로컬파트
// 파생은 쓰기 시점 기본값·제안값 계산 전용으로 강등됐다 — §3.1·§3.2, 읽기 경로 폴백 없음). GET /me는
// c.get('userId') → usersDao.findById() → user.employee_id 경로로만 스코프를 도출한다(§4.1). NULL이면
// (미연동 — 일상적 상태) 상류·D1 광역 조회를 시작하지 않고 조기 반환한다(I7). GET /users/:id는
// target.employee_id를 그대로 매처에 넣는다(§4.6). getUsageOverviewHybrid(env, { employeeId,
// requireEmployeeScope })가 하이브리드 조회의 유일한 스코프 인자다.
import { Hono } from 'hono'
import * as projectsDao from '../dao/projects.js'
import * as sessionsDao from '../dao/sessions.js'
import * as usersDao from '../dao/users.js'
import * as auditLogsDao from '../dao/audit-logs.js'
import * as usagePromDailyDao from '../dao/usage-prom-daily.js'
import * as sharedWorkstationsDao from '../dao/usage-shared-workstations.js'
import { requireAdmin } from '../middleware/jwt-auth.js'
import { withRouteBudget } from '../lib/prom-client.js'
import { runUsageRollup, ROLLUP_REQUEST_BUDGET_MS, REQUEST_CHUNK_RESERVE_MS } from '../lib/usage-rollup.js'
// m-2 수정(리뷰 2026-09-03) — todayDayAt/addDays를 이 파일에서 다시 구현하지 않고
// server/lib/day-boundary.js(정본, KST 전환 후)를 그대로 쓴다(이전에는 usage-prom.js/usage-rollup.js와
// 함께 3벌 복제). KST 전환(docs/design/usage-kst-day-boundary.md) — "오늘"의 기본값이 KST 자정
// 기준으로 바뀐다.
import { todayDayAt, addDays } from '../lib/day-boundary.js'
import { isPromSafeEmployeeId } from '../lib/usage-identity.js'
import {
  AGG_MODE,
  getUsageOverviewHybrid,
  getUserDrilldown,
  daySummaryRows,
  mergeD1AndPromUsers,
  resolveUsersSort,
  sortUserRows,
  userDayRows,
  userTotals,
  foldToEmployees,
  groupAccountsOf,
  zeroTotals,
  aggregateCacheMeta,
  UNAVAILABLE_FIELDS
} from '../lib/usage-prom.js'

const usage = new Hono()

function parseRange(c) {
  return { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined }
}

function parseLimit(c, fallback = 20, max = 100) {
  const n = Number.parseInt(c.req.query('limit') || '', 10)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}

// §5.8 관리자 사용량 드릴다운 공통 — from/to 형식·기본값(§5.8.0). YYYY-MM-DD 아니면 에러, 둘 다
// 생략 시 최근 30일(to=오늘 KST, from=to-29일), 한쪽만 주면 나머지만 기본값 적용, from>to면 에러.
// KST 전환(docs/design/usage-kst-day-boundary.md §11 docs/api.md:103) — "오늘"의 기준이 UTC에서
// KST로 바뀌었다. YYYY-MM-DD 형식 검증(isValidCalendarDate) 자체는 순수 라벨 산술이라 시간대와
// 무관하므로 무변경이다.
const ADMIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// 정규식은 자릿수 형식만 보고 달력상 실재 여부는 보지 않는다(M-2) — 2026-13-01·9999-99-99처럼
// Date.UTC가 오버플로 롤오버시키는 값을 넣어 연/월/일을 되짚어 원래 문자열과 일치하는지 확인한다.
// 불일치(롤오버 발생 또는 범위 밖)면 false. Date.UTC는 RangeError를 던지지 않으므로 안전.
function isValidCalendarDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

function resolveAdminRange(c) {
  const rawFrom = c.req.query('from')
  const rawTo = c.req.query('to')
  if (rawFrom && (!ADMIN_DATE_RE.test(rawFrom) || !isValidCalendarDate(rawFrom))) {
    return { error: 'from must be in YYYY-MM-DD format' }
  }
  if (rawTo && (!ADMIN_DATE_RE.test(rawTo) || !isValidCalendarDate(rawTo))) {
    return { error: 'to must be in YYYY-MM-DD format' }
  }
  const to = rawTo || todayDayAt()
  const from = rawFrom || addDays(to, -29)
  if (from > to) return { error: 'from must not be after to' }
  return { from, to }
}

function toPublicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status }
}

// 상류(Grafana/Prometheus) 실패를 503 UPSTREAM_UNAVAILABLE로 변환(설계 §9.3) — 401을 그대로
// 돌려주면 app/assets/js/utils.js의 useApi가 관리자를 강제 로그아웃시키므로 절대 401을 전파하지 않는다.
// UpstreamError가 아닌(D1 등 진짜 내부 오류) 예외는 그대로 다시 던져 webApp.onError(500)로 넘긴다.
function upstreamErrorResponse(c, err) {
  if (err && err.name === 'UpstreamError') {
    console.error('[admin usage] upstream failure', err.reason, err.message)
    return c.json({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: '사용량 데이터 소스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        details: { upstream: 'grafana-prometheus', reason: err.reason }
      }
    }, 503)
  }
  throw err
}

// /summary·/users 공통 meta(설계 §5.0·§17.6 정본) — getUsageOverviewHybrid()의 결과를 그대로 옮긴다.
// ⚠️ data_start는 rev.2에서 값이 없어도 키 자체는 항상 포함한다(null 허용, §12.1 — 생략하면 프런트가
// undefined 분기를 만들고 그 분기가 곧 "결손을 못 본 화면"이 된다).
function buildHybridMeta(range, hybrid) {
  const windowClamped = !!(hybrid.dataStart && range.from < hybrid.dataStart)
  return {
    from: range.from,
    to: range.to,
    source: 'prometheus',
    fetched_at: hybrid.cacheMeta.fetched_at,
    cache: { hit: hybrid.cacheMeta.hit, age_seconds: hybrid.cacheMeta.age_seconds, ttl_seconds: hybrid.cacheMeta.ttl_seconds },
    stale: hybrid.cacheMeta.stale,
    refresh_throttled: !!hybrid.cacheMeta.refresh_throttled,
    data_start: hybrid.dataStart,
    window_clamped: windowClamped,
    unavailable_fields: UNAVAILABLE_FIELDS,
    unknown_types: Array.from(hybrid.unknownTypes),
    segments: hybrid.segments,
    gap_days: hybrid.gapDays,
    rollup: hybrid.rollup,
    live_unavailable: hybrid.liveUnavailable
  }
}

// 미연동(identity_unlinked)·저장값 형식 이상(identity_invalid) — 상류 질의 자체를 하지 않는
// 경우의 meta(usage-employee-identity-linking.md §4.2 I7·§4.5 "상류 질의를 하지 않는다"). 정상
// 하이브리드 meta와 같은 키 집합을 유지해(값은 "질의 안 함"을 뜻하는 중립값) 프런트가 undefined
// 분기를 만들지 않게 한다(§12.1과 동일 원칙, buildHybridMeta 주석 참고).
function buildSkippedIdentityMeta(range, flags) {
  return {
    from: range.from,
    to: range.to,
    source: 'prometheus',
    fetched_at: new Date().toISOString(),
    cache: { hit: false, age_seconds: 0, ttl_seconds: 0 },
    stale: false,
    refresh_throttled: false,
    data_start: null,
    window_clamped: false,
    unavailable_fields: UNAVAILABLE_FIELDS,
    unknown_types: [],
    segments: { cached: null, live: null },
    gap_days: [],
    rollup: { cached_through: null, last_sync_at: null, agg_mode: AGG_MODE },
    live_unavailable: false,
    ...flags
  }
}

// /users/:id(전 구간 라이브) 전용 meta — segments.cached는 항상 null(캐시를 안 쓴다), rollup은
// 참고용(§5.0 "rollup.cached_through는 참고용으로만 채운다"), gap_days·live_unavailable은 이
// 라우트에 적용되지 않는 개념이라 항상 빈 배열/false로 고정한다(§20.4 "이 단계가 없다").
function buildDrilldownMeta(range, drilldown, overall) {
  const windowClamped = !!(overall.dataStart && range.from < overall.dataStart)
  return {
    from: range.from,
    to: range.to,
    source: 'prometheus',
    fetched_at: drilldown.meta.fetched_at,
    cache: { hit: drilldown.meta.hit, age_seconds: drilldown.meta.age_seconds, ttl_seconds: drilldown.meta.ttl_seconds },
    stale: drilldown.meta.stale,
    refresh_throttled: !!drilldown.meta.refresh_throttled,
    data_start: overall.dataStart,
    window_clamped: windowClamped,
    unavailable_fields: UNAVAILABLE_FIELDS,
    unknown_types: Array.from(drilldown.unknownTypes),
    segments: { cached: null, live: { from: range.from, to: range.to } },
    gap_days: [],
    rollup: { cached_through: null, last_sync_at: overall.lastSyncAt, agg_mode: AGG_MODE },
    live_unavailable: false
  }
}

// GET /api/usage/me?from=&to=&refresh= — 본인 스코프 하이브리드
// (docs/design/usage-employee-identity-linking.md §4). 관리자 /summary·/users와 완전히 같은
// getUsageOverviewHybrid()를 employeeId로 좁혀 재사용한다(완결일=D1 롤업 캐시 + 오늘=라이브). 날짜
// 범위 파싱·검증은 관리자 라우트와 동일한 resolveAdminRange()를 그대로 재사용한다(이름은 "admin"
// 이지만 로직 자체는 일반 날짜 범위 파서다 — from/to 형식 검증·기본값 최근 30일이 이 라우트에도
// 그대로 맞는다).
//
// 도출 경로(§4.1, 다른 경로 없음): c.get('userId') → usersDao.findById() → user.employee_id →
// isPromSafeEmployeeId() 재검증 → getUsageOverviewHybrid({ employeeId, requireEmployeeScope: true }).
// IDOR 방지: employeeId는 오직 JWT 서명 검증값(userId)으로 조회한 D1 행에서만 나온다 — 쿼리
// 파라미터·바디로 다른 사람의 식별자를 받는 경로 자체가 이 라우트에 없다(I8).
//
// ⚠️ I7 비협상 — employee_id가 없으면(미연동, NULL) 여기서 조기 반환하고 getUsageOverviewHybrid를
// 절대 호출하지 않는다. resolveEmployeeScope(null)은 scoped:false(=무필터/전사)를 뜻하므로, 이
// 가드 없이 그대로 호출하면 일반 직원이 전사 사용량을 보게 된다. requireEmployeeScope:true가
// 라이브러리 레벨의 안전망(2차 방어)이고, 이 조기 반환이 1차 방어다 — 둘 다 유지한다.
//
// 세 가지 "빈 결과"를 구분한다(§4.5): identity_unlinked(employee_id가 NULL, 미연동 — 일상적 상태) /
// identity_invalid(저장값 형식 위반, 운영상 발생 불가) / user_not_in_metrics(축은 정상, 이 기간
// 관측치 없음 — Prometheus에 데이터가 없는 사용자는 에러가 아니라 200 + 빈 결과). 앞의 둘은 상류
// 질의 자체를 하지 않는다.
usage.get('/me', async (c) => {
  const userId = c.get('userId')
  const range = resolveAdminRange(c)
  if (range.error) return c.json({ error: { code: 'VALIDATION_ERROR', message: range.error } }, 400)
  const refresh = c.req.query('refresh') === '1'

  const user = await usersDao.findById(c.env.DB, userId)
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'user not found' } }, 404)

  const employeeId = user.employee_id || null

  // I7 1차 방어(라우트 조기 반환) — 미연동이면 상류·D1 광역 조회를 시작하지 않는다. 이 분기를
  // 지우지 말 것(비협상) — 지우면 아래 requireEmployeeScope 가드만 남는데, 그건 안전망이지 이
  // 분기를 대체하는 것이 아니다(호출 자체를 아끼는 것도 이 분기의 목적).
  if (!employeeId) {
    const meta = buildSkippedIdentityMeta(range, { employee_id: null, group_accounts: [], identity_unlinked: true })
    return c.json({ data: [], totals: zeroTotals(), meta })
  }

  // I9(usage-shared-workstation-axes.md §4.2) — 본인 축이 공용 워크스테이션으로 등록돼 있으면
  // 상류·D1 광역 조회를 시작하지 않고 200 + 전용 meta 플래그로 조기 반환한다. I7("값이 없으면")의
  // 자매 조항: I7은 *없는* 축, I9는 *개인이 아닌* 축을 막는다. 이 축의 사용량은 여러 사람의 합계라
  // 개인 화면에 띄우는 순간 그 자체가 오귀속이고, 당사자는 자기 숫자가 부풀었다는 사실을 알 수 없다.
  //
  // ⚠️ 전건 스캔(loadMap)이 아니라 **PK 단건 조회**다 — 이 지점은 "이 하나의 값이 공용인가"만
  //    알면 되고, 레지스트리가 커져도 비용이 고정이다.
  // ⚠️ 조용한 빈 화면을 만들지 않는다(이 프로젝트가 반복해서 밟은 실패 모드) — user_not_in_metrics와
  //    구분 가능한 전용 플래그를 반드시 실어 화면이 다른 문구를 낼 수 있게 한다.
  // ⚠️ fail-closed — 이 조회가 실패하면 예외를 그대로 흘려 500이 되게 둔다(try/catch로 삼켜서
  //    "레지스트리를 못 읽었으니 개인으로 취급"하면 그 순간 오귀속이 발생한다, 설계 S10).
  const sharedSelf = await sharedWorkstationsDao.findById(c.env.DB, employeeId)
  if (sharedSelf) {
    const meta = buildSkippedIdentityMeta(range, {
      employee_id: employeeId,
      group_accounts: [],
      identity_shared_workstation: true
    })
    return c.json({ data: [], totals: zeroTotals(), meta })
  }

  // 매처 삽입 직전 재검증(I1의 실제 방어선, §4.1) — 저장값이라도 다시 본다. 운영상 발생 불가
  // (편집 API가 이미 형식·길이를 강제한다)하지만, 직접 DB 조작 등으로 어긋난 값이 들어와도 무필터로
  // 넓히지 않고 정직하게 빈 결과 + identity_invalid를 낸다.
  if (!isPromSafeEmployeeId(employeeId)) {
    console.error('[usage] stored employee_id failed safety re-check', user.id, employeeId)
    const meta = buildSkippedIdentityMeta(range, { employee_id: employeeId, group_accounts: [], identity_invalid: true })
    return c.json({ data: [], totals: zeroTotals(), meta })
  }

  let hybrid
  try {
    hybrid = await getUsageOverviewHybrid(c.env, { from: range.from, to: range.to, refresh, employeeId, requireEmployeeScope: true })
  } catch (err) {
    return upstreamErrorResponse(c, err)
  }

  // hybrid.byUnit은 employee_id="<employeeId>" 매처/SQL 필터로 이미 좁혀져 있다 — foldToEmployees로
  // 계정(그룹 로그인 이메일) 축을 접어 직원 1행(emp:<employeeId>)을 얻는다. 그 직원 항목이 없으면
  // (Prometheus에 데이터가 없는 사용자, 수집 대상 아님) 에러가 아니라 200 + data:[] + totals 0을
  // 정상 반환한다.
  const employees = foldToEmployees(hybrid.byUnit, hybrid.sharedById)
  const folded = employees.get(`emp:${employeeId}`)
  // 2차 방어 — 위 I9 조기 반환이 1차다. rowKey를 shr:로 바꾸지 않기로 했으므로(PM 판정1) 키 미스가
  // 아니라 이 명시적 검사가 최종 방어선이다: 조기 반환과 이 지점 사이에 등록이 일어나도(요청 처리
  // 도중 다른 관리자가 등록) 개인 화면에 공용 축 합계가 뜨지 않는다.
  const emp = folded && folded.isShared ? null : folded
  const data = (emp ? userDayRows(emp) : []).map((r) => ({
    ...r, tool_calls: null, tool_errors: null, retries: null, turns: null, api_calls: null, updated_at: null
  }))
  const totals = emp ? userTotals(emp) : zeroTotals()

  const meta = buildHybridMeta(range, hybrid)
  meta.employee_id = employeeId
  meta.group_accounts = emp ? groupAccountsOf(emp) : []
  if (!emp) meta.user_not_in_metrics = true
  // 요청 처리 도중(위 조기 반환 이후) 그 축이 공용으로 등록된 희귀 경합 — 빈 화면의 이유를
  // user_not_in_metrics로 위장하지 않고 정확한 플래그를 함께 싣는다.
  if (folded && folded.isShared) meta.identity_shared_workstation = true

  return c.json({ data, totals, meta })
})

// GET /api/usage/projects/:id?from=&to= — 본인 소유 project만. usage_daily엔 project_id가 없어
// (§0 결정25) sessions를 WHERE project_id=? AND user_id=? GROUP BY day_at로 직접 재집계한다.
// 타인 소유 project_id는 404로 위장(IDOR 방지, api.md §5.3과 동일 house style — 403 대신 404).
usage.get('/projects/:id', async (c) => {
  const userId = c.get('userId')
  const project = await projectsDao.findOwnedById(c.env.DB, userId, c.req.param('id'))
  if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'project not found' } }, 404)

  const data = await sessionsDao.sumByProjectDay(c.env.DB, project.id, userId, parseRange(c))
  return c.json({ data })
})

// GET /api/usage/sessions?cursor=&limit=&user_id= — 본인(기본) 또는 administrator+user_id 쿼리.
usage.get('/sessions', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'administrator'
  const queryUserId = c.req.query('user_id')

  let targetUserId = userId
  if (queryUserId && queryUserId !== userId) {
    if (!isAdmin) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'administrator role required to view other users sessions' } }, 403)
    }
    targetUserId = queryUserId
  }

  const page = await sessionsDao.listForUser(c.env.DB, targetUserId, {
    cursor: c.req.query('cursor') || undefined,
    limit: parseLimit(c)
  })
  return c.json(page)
})

export default usage

// GET /api/admin/usage/summary?from=&to=&refresh= — administrator만. 전사(전 사용자) 일별 추세.
// rev.2 하이브리드(완결일=D1 롤업 캐시 + 오늘=라이브, docs/design/usage-prometheus-realtime.md
// §19.4 정본, architecture.md §0 결정29 개정). /users와 완전히 같은 getUsageOverviewHybrid() 결과를
// 축만 바꿔 접는다 — 합성은 그 함수 한 곳에서만 일어나므로 KPI(요약)와 표(목록)의 총합이 구조적으로
// 일치한다(§5.2).
export const adminUsage = new Hono()
adminUsage.get('/summary', requireAdmin, async (c) => {
  const range = resolveAdminRange(c)
  if (range.error) return c.json({ error: { code: 'VALIDATION_ERROR', message: range.error } }, 400)
  const refresh = c.req.query('refresh') === '1'

  let hybrid
  try {
    // M-1 수정 — withRouteBudget은 이제 getUsageOverviewHybrid() 내부(라이브 질의 promise 하나)에만
    // 걸린다(usage-prom.js). 여기서 전체 호출을 다시 감싸면 예산 초과 시 이미 읽은 D1 캐시 구간까지
    // 버려지고 503이 나가던 원래 버그가 재발한다 — 절대 다시 감싸지 말 것.
    hybrid = await getUsageOverviewHybrid(c.env, { from: range.from, to: range.to, refresh })
  } catch (err) {
    return upstreamErrorResponse(c, err)
  }

  const data = daySummaryRows(hybrid.byUnit)
  const meta = buildHybridMeta(range, hybrid)

  return c.json({ data, meta })
})

// GET /api/admin/usage/users?from=&to=&sort=&order=&limit=&refresh= — 직원별 기간 합계 목록
// (docs/design/usage-employee-identity.md §7.1). D1 users를 좌항으로 두고 Prometheus 사용량을
// employee_id로 병합 — D1에 없는 Prometheus-only 직원, employee_id 라벨이 없는 그룹 계정 행도
// 버리지 않고 포함한다(§5.2 폴백). 로컬파트 충돌은 usersDao.listAll() 결과 안에서만 판정해(§13
// 쟁점3 하이브리드 결정) D1 왕복을 늘리지 않는다.
adminUsage.get('/users', requireAdmin, async (c) => {
  const range = resolveAdminRange(c)
  if (range.error) return c.json({ error: { code: 'VALIDATION_ERROR', message: range.error } }, 400)

  const rawSort = c.req.query('sort') || 'tokens'
  const sortResolution = resolveUsersSort(rawSort)
  if (!sortResolution.sort) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'sort must be one of tokens, sessions, name, last_active, cost' }
    }, 400)
  }

  const rawOrder = c.req.query('order')
  if (rawOrder !== undefined && rawOrder !== 'asc' && rawOrder !== 'desc') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'order must be asc or desc' } }, 400)
  }
  // order 기본값은 desc, 단 sort=name일 때만 기본 asc(기존 §5.8.1 쿼리 파라미터 표 관례 유지).
  const order = rawOrder || (sortResolution.sort === 'name' ? 'asc' : 'desc')
  const limit = parseLimit(c, 100, 500)
  const refresh = c.req.query('refresh') === '1'

  let hybrid
  let d1Users
  try {
    // M-1 수정 — 이유는 /summary와 동일(위 주석 참고). usersDao.listAll은 D1 단일 쿼리라 예산으로
    // 보호할 만큼 느릴 이유가 없고, getUsageOverviewHybrid 자체가 라이브 구간만 내부에서 예산을 건다.
    ;[hybrid, d1Users] = await Promise.all([
      getUsageOverviewHybrid(c.env, { from: range.from, to: range.to, refresh }),
      usersDao.listAll(c.env.DB)
    ])
  } catch (err) {
    return upstreamErrorResponse(c, err)
  }

  // hybrid.sharedById — getUsageOverviewHybrid가 캐시 스냅샷과 병렬로 읽은 공용 워크스테이션
  // 레지스트리(usage-shared-workstation-axes.md). 등록된 축은 어떤 회원 행에도 귀속되지 않고
  // 별도 행으로 남는다(총합 보존).
  const merged = mergeD1AndPromUsers(d1Users, hybrid.byUnit, hybrid.sharedById)
  const sorted = sortUserRows(merged, sortResolution.field, order)
  const truncated = sorted.length > limit
  const data = truncated ? sorted.slice(0, limit) : sorted

  const meta = buildHybridMeta(range, hybrid)
  meta.sort = sortResolution.sort
  meta.order = order
  meta.limit = limit
  meta.returned = data.length
  meta.truncated = truncated

  return c.json({ data, meta })
})

// POST /api/admin/usage/sync — administrator만. Cron(§18.1)과 동일한 runUsageRollup()을 짧은 예산
// (ROLLUP_REQUEST_BUDGET_MS)으로 1회 실행(설계 §18.7 — 있으면 좋음, 필수 아님). 배포 직후 즉시
// 채우기 / Cron 실패 후 즉시 복구 용도. 부분 성공도 그대로 200(커밋된 날짜는 실제로 커밋됐다) —
// 한 청크도 못 하면(=상류가 완전히 죽어 있으면) UpstreamError가 그대로 던져져 기존 503 매핑을 탄다.
adminUsage.post('/sync', requireAdmin, async (c) => {
  try {
    // C-1 수정 — 요청 경로 전용 reserve(REQUEST_CHUNK_RESERVE_MS)를 함께 넘긴다. Cron 전용
    // reserve(CHUNK_RESERVE_MS=35000)를 그대로 썼을 때 요청 예산(구 8000ms)보다 항상 커서 청크가
    // 단 하나도 실행되지 못하던 산술 모순이 여기서 발생했었다(server/lib/usage-rollup.js 참고).
    const result = await runUsageRollup(c.env, { budgetMs: ROLLUP_REQUEST_BUDGET_MS, reserveMs: REQUEST_CHUNK_RESERVE_MS })
    // m-8 수정(리뷰 2026-09-03) — 이 라우트는 전사 사용량 D1 롤업 캐시에 직접 쓰는 유일한 관리자
    // 액션이라 감사기록을 남긴다(migrations/0018). best-effort(기존 admin.cross_user_view 방침과
    // 동일) — INSERT 실패가 이미 끝난 적재 자체를 실패로 만들지 않는다.
    try {
      await auditLogsDao.record(c.env.DB, {
        actorUserId: c.get('userId'),
        action: 'admin.usage_sync',
        targetType: null,
        targetId: null,
        metadata: { committed_days: result.committed_days.length, remaining_gap_days: result.remaining_gap_days.length, budget_exhausted: result.budget_exhausted }
      })
    } catch (err) {
      console.error('admin.usage_sync audit log write failed', err)
    }
    return c.json(result)
  } catch (err) {
    return upstreamErrorResponse(c, err)
  }
})

// GET /api/admin/usage/users/:id?from=&to=&refresh= — 특정 직원 1명의 일별 롤업 + 기간 합계 +
// 모델별 사용량(docs/design/usage-employee-identity-linking.md §4.6). GET /api/usage/me와의 shape
// 동일화 전제는 이 라우트에 한해 폐기(§5.8.4 함정8 폐기) — Prometheus에 없는 5개 필드는 null.
//
// :id는 D1 users.id(ULID) 그대로다(§4.6 — employee_id를 URL 식별자로 쓰지 않는다, 열거 표면 방지).
// 매처 축은 target.employee_id 컬럼 그대로(이메일 로컬파트 파생 없음, §3.2 단방향 원칙). NULL이면
// (미연동) 상류 질의를 하지 않고 200 + 빈 데이터 + identity_unlinked + user_not_in_metrics.
adminUsage.get('/users/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const target = await usersDao.findById(c.env.DB, id)
  if (!target) return c.json({ error: { code: 'NOT_FOUND', message: 'user not found' } }, 404)

  const range = resolveAdminRange(c)
  if (range.error) return c.json({ error: { code: 'VALIDATION_ERROR', message: range.error } }, 400)
  const refresh = c.req.query('refresh') === '1'

  const employeeId = target.employee_id || null

  // 공용 워크스테이션 축 판정(usage-shared-workstation-axes.md §4.3) — PK 단건 조회(전건 스캔 아님).
  // 대상 회원의 연동 값이 공용 축이면 상류 질의 없이 200 + 전용 meta 플래그를 준다: 그 축의 사용량은
  // 여러 사람의 합계라 특정 개인의 드릴다운으로 보여줄 수 없다. fail-closed(조회 실패 → 예외 전파
  // → 500)이며, 빈 Map/false로 눙치지 않는다(설계 S10).
  const sharedTarget = employeeId ? await sharedWorkstationsDao.findById(c.env.DB, employeeId) : null

  let drilldown
  let overall
  try {
    if (!employeeId || sharedTarget) {
      // §4.6 — 미연동(NULL)이면 상류 질의 자체를 하지 않는다. overall(coverage)은 D1 전용 조회라
      // 계속 읽어 meta.data_start 등은 정상 채운다. getUserDrilldown은 저장값이 안전하지 않은 경우도
      // 내부에서 이미 빈 결과로 처리하므로(isPromSafeEmployeeId 재검증) 무필터로 뒤집히지 않는다 —
      // 그래도 NULL은 라우트에서 먼저 끊어 상류 왕복을 아끼고 identity_unlinked 플래그를 정확히 낸다.
      // 공용 워크스테이션 축(sharedTarget)도 같은 분기를 탄다 — 상류 왕복을 아끼고 아래에서
      // identity_shared_workstation 플래그를 정확히 낸다(getUserDrilldown 내부에도 2차 방어가 있다).
      drilldown = { notInMetrics: true, sharedWorkstation: !!sharedTarget, rows: [], totals: { ...zeroTotals(), active_time_seconds: 0 }, groupAccounts: [], byModel: [], unknownTypes: new Set(), meta: aggregateCacheMeta([]) }
      overall = await usagePromDailyDao.readOverallCoverage(c.env.DB)
    } else {
      ;[drilldown, overall] = await withRouteBudget(Promise.all([
        getUserDrilldown(c.env, { from: range.from, to: range.to, employeeId, refresh }),
        // meta.data_start는 rev.2부터 D1 MIN(day_at) 한 줄로 얻는다(§4.5) — 상류 180일 프로브(rev.1,
        // 실측 ~4초로 상류 자체 타임아웃 코앞이라 사실상 비활성이었다)는 폐기했다. 이 라우트는 전 구간
        // 라이브라 캐시를 안 쓰지만, data_start는 "우리가 답할 수 있는 첫 날"의 참고값으로 여전히 싣는다.
        usagePromDailyDao.readOverallCoverage(c.env.DB)
      ]))
    }
  } catch (err) {
    return upstreamErrorResponse(c, err)
  }

  // 감사 로그는 best-effort(기존 §5.8.0 방침 유지) — INSERT 실패가 이 읽기 전용 조회 자체를 막지 않는다.
  try {
    await auditLogsDao.record(c.env.DB, {
      actorUserId: c.get('userId'),
      action: 'admin.cross_user_view',
      targetType: 'user',
      targetId: id,
      metadata: { from: range.from, to: range.to }
    })
  } catch (err) {
    console.error('admin.cross_user_view audit log write failed', err)
  }

  const data = drilldown.rows.map((r) => ({
    user_id: target.id,
    day_at: r.day_at,
    session_count: r.session_count,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_write_tokens: r.cache_write_tokens,
    total_tokens: r.total_tokens,
    cost_usd: r.cost_usd,
    tool_calls: null, tool_errors: null, retries: null, turns: null, api_calls: null,
    updated_at: null
  }))

  const totals = {
    session_count: drilldown.totals.session_count,
    input_tokens: drilldown.totals.input_tokens,
    output_tokens: drilldown.totals.output_tokens,
    cache_read_tokens: drilldown.totals.cache_read_tokens,
    cache_write_tokens: drilldown.totals.cache_write_tokens,
    total_tokens: drilldown.totals.total_tokens,
    cost_usd: drilldown.totals.cost_usd,
    active_time_seconds: drilldown.totals.active_time_seconds,
    active_days: drilldown.totals.active_days
  }

  const meta = buildDrilldownMeta(range, drilldown, overall)
  if (drilldown.notInMetrics) meta.user_not_in_metrics = true
  if (!employeeId) meta.identity_unlinked = true
  // 조용한 빈 화면 금지 — "관측치가 없다(user_not_in_metrics)"와 "공용 축이라 개인에게 귀속하지
  // 않는다"는 화면 문구·조치가 완전히 다르다. drilldown.sharedWorkstation은 라이브 경로(2차 방어)가
  // 켠 값도 포함한다.
  if (sharedTarget || drilldown.sharedWorkstation) meta.identity_shared_workstation = true

  return c.json({
    user: toPublicUser(target),
    data,
    totals,
    employee_id: employeeId || null,
    group_accounts: drilldown.groupAccounts || [],
    by_model: drilldown.byModel,
    code: null, // G2(lines_of_code 등 라벨셋) 미확인 — 확인 전까지 null(설계 §4.5 R4)
    meta
  })
})
