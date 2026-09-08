// GET /api/usage/me 라우트 레벨 단위테스트 — 완료판정 항목1 "다른 사용자의 데이터를 볼 수 있는
// 경로가 없음을 테스트로 증명"의 실측 근거. docs/design/usage-employee-identity-linking.md §4 전환
// 이후에는 employee_id의 정본이 D1 users.employee_id 컬럼이다(이메일 로컬파트 파생 폴백 없음) —
// 도출 경로는 c.get('userId') → usersDao.findById() → user.employee_id 하나뿐이다.
// server/lib/usage-prom.js는 getUsageOverviewHybrid만 vi.mock으로 대체(그 외 foldToEmployees/
// userDayRows/userTotals/unitKeyOf 등은 실제 구현을 그대로 써서 라우트의 접기·응답 조립 로직까지
// 함께 검증한다), server/dao/users.js는 findById만 대체해 D1 없이 연동 상태를 통제한다.
// D1/Prometheus 네트워크 의존은 없다.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const getUsageOverviewHybridMock = vi.fn()
const findByIdMock = vi.fn()
// 공용 워크스테이션 레지스트리(usage_shared_workstations) PK 단건 조회 — /me와 드릴다운이
// "이 축이 공용인가"를 묻는 유일한 경로다(docs/design/usage-shared-workstation-axes.md).
const sharedFindByIdMock = vi.fn()

const getUserDrilldownMock = vi.fn()
const readOverallCoverageMock = vi.fn()
const auditRecordMock = vi.fn()

vi.mock('../lib/usage-prom.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getUsageOverviewHybrid: (...args) => getUsageOverviewHybridMock(...args),
    getUserDrilldown: (...args) => getUserDrilldownMock(...args)
  }
})

vi.mock('../dao/usage-prom-daily.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, readOverallCoverage: (...args) => readOverallCoverageMock(...args) }
})

vi.mock('../dao/audit-logs.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, record: (...args) => auditRecordMock(...args) }
})

vi.mock('../dao/users.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, findById: (...args) => findByIdMock(...args) }
})

vi.mock('../dao/usage-shared-workstations.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, findById: (...args) => sharedFindByIdMock(...args) }
})

const { default: usage, adminUsage } = await import('./usage.js')
const { unitKeyOf } = await import('../lib/usage-prom.js')

const SELF_USER_ID = 'user-self-id'
const SELF_EMAIL = 'self@malgnsoft.com'
const SELF_EMPLOYEE_ID = 'self'

function selfUserRow(overrides = {}) {
  return { id: SELF_USER_ID, email: SELF_EMAIL, name: '본인', role: 'employee', status: 'active', employee_id: SELF_EMPLOYEE_ID, ...overrides }
}

function unitEntry({ employeeId = null, userEmail = null, days = [] }) {
  return { employeeId, userEmail, employeeNames: new Set(), days: new Map(days) }
}

function buildHybrid(byUnitEntries, sharedById = new Map()) {
  return {
    byUnit: new Map(byUnitEntries),
    sharedById,
    unknownTypes: new Set(),
    cacheMeta: { hit: true, age_seconds: 5, ttl_seconds: 60, stale: false, fetched_at: '2026-09-04T00:00:00.000Z', refresh_throttled: false },
    dataStart: '2026-07-28',
    segments: { cached: { from: '2026-08-05', to: '2026-09-03' }, live: { from: '2026-09-04', to: '2026-09-04' } },
    gapDays: [],
    rollup: { cached_through: '2026-09-03', last_sync_at: '2026-09-04T01:00:00.000Z', agg_mode: 'increase' },
    liveUnavailable: false
  }
}

function makeApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId', SELF_USER_ID)
    c.set('userRole', 'employee')
    c.set('userEmail', SELF_EMAIL)
    await next()
  })
  app.route('/api/usage', usage)
  return app
}

beforeEach(() => {
  getUsageOverviewHybridMock.mockReset()
  findByIdMock.mockReset()
  sharedFindByIdMock.mockReset()
  getUserDrilldownMock.mockReset()
  readOverallCoverageMock.mockReset()
  auditRecordMock.mockReset()
  findByIdMock.mockResolvedValue(selfUserRow()) // 기본: 연동됨(employee_id='self')
  sharedFindByIdMock.mockResolvedValue(null) // 기본: 공용 워크스테이션으로 등록되지 않음
  readOverallCoverageMock.mockResolvedValue({ dataStart: '2026-07-28', lastSyncAt: '2026-09-04T01:00:00.000Z' })
  auditRecordMock.mockResolvedValue('audit-id')
})

describe('GET /api/usage/me — 본인 스코프 강제(IDOR 방지)', () => {
  it('쿼리에 다른 사용자 email/user_id/user_email/employee_id를 실어 보내도 무시하고 항상 D1에서 조회한 본인 행의 employee_id로만 조회한다', async () => {
    getUsageOverviewHybridMock.mockResolvedValue(buildHybrid([]))
    const app = makeApp()

    const res = await app.request(
      '/api/usage/me?email=attacker@evil.com&user_id=someone-else&user_email=victim@malgnsoft.com&employee_id=victim',
      {},
      { DB: {} }
    )

    expect(res.status).toBe(200)
    expect(findByIdMock).toHaveBeenCalledWith(expect.anything(), SELF_USER_ID) // JWT userId로만 조회
    expect(getUsageOverviewHybridMock).toHaveBeenCalledTimes(1)
    const [, args] = getUsageOverviewHybridMock.mock.calls[0]
    expect(args.employeeId).toBe(SELF_EMPLOYEE_ID) // 쿼리 파라미터는 전혀 반영되지 않는다
    expect(args.requireEmployeeScope).toBe(true) // I7 안전망이 항상 켜져 있다
  })

  it('하위 계층(getUsageOverviewHybrid)이 실수로 타인 데이터를 함께 반환해도 응답은 본인 employee_id 키만 읽는다', async () => {
    const victimUnit = unitEntry({
      employeeId: 'victim', userEmail: 'victim@malgnsoft.com',
      days: [['2026-09-01', { input_tokens: 999999, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, session_count: 1, cost_usd: 100 }]]
    })
    const selfUnit = unitEntry({
      employeeId: SELF_EMPLOYEE_ID, userEmail: SELF_EMAIL,
      days: [['2026-09-01', { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, session_count: 1, cost_usd: 0.01 }]]
    })
    getUsageOverviewHybridMock.mockResolvedValue(buildHybrid([
      [unitKeyOf('victim', 'victim@malgnsoft.com'), victimUnit],
      [unitKeyOf(SELF_EMPLOYEE_ID, SELF_EMAIL), selfUnit]
    ]))
    const app = makeApp()

    const res = await app.request('/api/usage/me', {}, {})
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].input_tokens).toBe(100) // victim의 999999가 아니다
    expect(body.totals.input_tokens).toBe(100)
  })

  it('Prometheus에 데이터가 없는 사용자(수집 대상 아님) → 에러가 아니라 200 + 빈 데이터 + user_not_in_metrics', async () => {
    getUsageOverviewHybridMock.mockResolvedValue(buildHybrid([]))
    const app = makeApp()

    const res = await app.request('/api/usage/me', {}, {})
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.totals.session_count).toBe(0)
    expect(body.totals.total_tokens).toBe(0)
    expect(body.meta.user_not_in_metrics).toBe(true)
    expect(body.meta.employee_id).toBe(SELF_EMPLOYEE_ID)
    expect(body.meta.group_accounts).toEqual([])
  })

  it('하이브리드 meta(segments/gap_days/rollup 등)를 그대로 노출한다', async () => {
    getUsageOverviewHybridMock.mockResolvedValue(buildHybrid([]))
    const app = makeApp()

    const res = await app.request('/api/usage/me', {}, {})
    const body = await res.json()

    expect(body.meta.source).toBe('prometheus')
    expect(body.meta.segments).toEqual({ cached: { from: '2026-08-05', to: '2026-09-03' }, live: { from: '2026-09-04', to: '2026-09-04' } })
    expect(body.meta.gap_days).toEqual([])
    expect(body.meta.rollup.agg_mode).toBe('increase')
  })

  it('from/to 형식이 잘못되면 400을 반환하고 D1/상류를 아예 부르지 않는다', async () => {
    const app = makeApp()
    const res = await app.request('/api/usage/me?from=2026/09/01', {}, {})

    expect(res.status).toBe(400)
    expect(findByIdMock).not.toHaveBeenCalled()
    expect(getUsageOverviewHybridMock).not.toHaveBeenCalled()
  })

  it('상류 장애(UpstreamError)는 503 UPSTREAM_UNAVAILABLE + reason으로 변환된다(401을 그대로 전파하지 않는다)', async () => {
    const err = new Error('grafana auth failed: 401')
    err.name = 'UpstreamError'
    err.reason = 'auth'
    getUsageOverviewHybridMock.mockRejectedValue(err)
    const app = makeApp()

    const res = await app.request('/api/usage/me', {}, {})
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE')
    expect(body.error.details.reason).toBe('auth')
  })

  it('JWT는 유효한데 D1에 사용자 행이 없으면 404 NOT_FOUND(GET /api/auth/me와 동일 house style)', async () => {
    findByIdMock.mockResolvedValue(null)
    const app = makeApp()

    const res = await app.request('/api/usage/me', {}, {})
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(getUsageOverviewHybridMock).not.toHaveBeenCalled()
  })

  it('I7 비협상 — employee_id가 NULL(미연동)이면 상류 질의 자체를 하지 않고 200 + 빈 데이터 + identity_unlinked를 반환한다', async () => {
    findByIdMock.mockResolvedValue(selfUserRow({ employee_id: null }))
    const app = makeApp()

    const res = await app.request('/api/usage/me', {}, {})
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.totals.total_tokens).toBe(0)
    expect(body.meta.identity_unlinked).toBe(true)
    expect(body.meta.employee_id).toBeNull()
    expect(getUsageOverviewHybridMock).not.toHaveBeenCalled() // 상류 질의 자체를 생략한다(I7)
  })

  it('저장값이 형식 위반(운영상 발생 불가, 직접 DB 조작 등)이면 상류 질의를 생략하고 200 + identity_invalid를 반환한다(I1 재검증)', async () => {
    findByIdMock.mockResolvedValue(selfUserRow({ employee_id: 'a"{user_email=~".*"}' })) // 라벨 인젝션 시도 문자
    const app = makeApp()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/api/usage/me', {}, {})
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.meta.identity_invalid).toBe(true)
    expect(body.meta.employee_id).toBe('a"{user_email=~".*"}')
    expect(getUsageOverviewHybridMock).not.toHaveBeenCalled()
    expect(consoleErrorSpy).toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('길이 상한(64자) 초과 저장값도 identity_invalid로 정직하게 빈 결과를 낸다(무필터로 넓히지 않는다)', async () => {
    findByIdMock.mockResolvedValue(selfUserRow({ employee_id: 'a'.repeat(65) }))
    const app = makeApp()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/api/usage/me', {}, {})
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.meta.identity_invalid).toBe(true)
    expect(getUsageOverviewHybridMock).not.toHaveBeenCalled()
  })
})

// I9(docs/design/usage-shared-workstation-axes.md §4.2) — 본인 축이 공용 워크스테이션으로 등록돼
// 있으면 개인 화면에 여러 사람의 합계를 절대 띄우지 않는다. 조용한 빈 화면을 만들지 않는 것이
// PM 판정3의 핵심이다 — user_not_in_metrics와 구분 가능한 전용 플래그를 반드시 싣는다.
describe('GET /api/usage/me — I9 공용 워크스테이션 축', () => {
  const SHARED_ROW = { employee_id: 'claude', label: '3층 공용 PC', note: null, registered_by: null, created_at: '2026-09-08T02:00:00.000Z', updated_at: '2026-09-08T02:00:00.000Z' }

  it('본인 축이 등록된 공용 축이면 상류 질의 없이 200 + identity_shared_workstation, 빈 데이터', async () => {
    findByIdMock.mockResolvedValue(selfUserRow({ employee_id: 'claude' }))
    sharedFindByIdMock.mockResolvedValue(SHARED_ROW)
    const app = makeApp()

    const res = await app.request('/api/usage/me', {}, { DB: {} })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.totals.total_tokens).toBe(0)
    expect(body.meta.identity_shared_workstation).toBe(true)
    expect(body.meta.employee_id).toBe('claude')
    expect(body.meta.group_accounts).toEqual([])
    // "조회 안 함" 중립 meta라 정상 응답과 키 집합이 같다(프런트가 undefined 분기를 만들지 않게).
    expect(body.meta.gap_days).toEqual([])
    expect(body.meta.identity_unlinked).toBeUndefined()
    expect(body.meta.user_not_in_metrics).toBeUndefined() // 빈 결과 4종이 서로 구분된다
    expect(getUsageOverviewHybridMock).not.toHaveBeenCalled() // 상류 fetch 0회
    // 전건 스캔이 아니라 PK 단건 조회 — 레지스트리가 커져도 비용이 고정이다.
    expect(sharedFindByIdMock).toHaveBeenCalledWith(expect.anything(), 'claude')
  })

  it('레지스트리 조회가 실패하면 fail-open 하지 않는다 — 개인으로 취급해 진행하지 않고 예외가 전파된다(S10)', async () => {
    findByIdMock.mockResolvedValue(selfUserRow({ employee_id: 'claude' }))
    sharedFindByIdMock.mockRejectedValue(new Error('D1_ERROR: connection lost'))
    const app = makeApp()
    app.onError((err, c) => c.json({ error: { code: 'INTERNAL_ERROR', message: err.message } }, 500))

    const res = await app.request('/api/usage/me', {}, { DB: {} })

    expect(res.status).toBe(500)
    expect(getUsageOverviewHybridMock).not.toHaveBeenCalled() // 못 읽었으면 아무것도 하지 않는다
  })

  it('등록되지 않은 축은 기존 경로 그대로 — 하이브리드 조회로 진행한다(등록 전까지 동작 무변경)', async () => {
    getUsageOverviewHybridMock.mockResolvedValue(buildHybrid([]))
    const app = makeApp()

    const res = await app.request('/api/usage/me', {}, { DB: {} })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.meta.identity_shared_workstation).toBeUndefined()
    expect(getUsageOverviewHybridMock).toHaveBeenCalledTimes(1)
  })

  it('2차 방어 — 조기 반환 이후 등록된 경합 상황(hybrid.sharedById에만 있음)에서도 본인 화면에 공용 축 합계가 뜨지 않는다', async () => {
    const selfUnit = unitEntry({
      employeeId: SELF_EMPLOYEE_ID, userEmail: SELF_EMAIL,
      days: [['2026-09-01', { input_tokens: 777, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, session_count: 1, cost_usd: 1 }]]
    })
    getUsageOverviewHybridMock.mockResolvedValue(buildHybrid(
      [[unitKeyOf(SELF_EMPLOYEE_ID, SELF_EMAIL), selfUnit]],
      new Map([[SELF_EMPLOYEE_ID, { ...SHARED_ROW, employee_id: SELF_EMPLOYEE_ID }]])
    ))
    const app = makeApp()

    const res = await app.request('/api/usage/me', {}, { DB: {} })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.totals.total_tokens).toBe(0)
    expect(body.meta.identity_shared_workstation).toBe(true)
  })
})

// GET /api/admin/usage/users/:id — 드릴다운의 공용 워크스테이션 처리(설계 §4.3).
// "조용한 빈 화면"을 만들지 않는다: user_not_in_metrics(관측치 없음)와 identity_shared_workstation
// (공용 축이라 개인에게 귀속하지 않음)은 화면 문구·조치가 완전히 다르다.
describe('GET /api/admin/usage/users/:id — 공용 워크스테이션 축', () => {
  const TARGET_ID = '01k2s7m9f0abcdefghijklmnop'
  const ADMIN_ID = 'admin-actor-id'
  const SHARED_ROW = { employee_id: 'claude', label: '3층 공용 PC', note: null, registered_by: null, created_at: '2026-09-08T02:00:00.000Z', updated_at: '2026-09-08T02:00:00.000Z' }

  function targetRow(overrides = {}) {
    return { id: TARGET_ID, email: 'djkim@malgnsoft.com', name: '김덕조', role: 'employee', status: 'active', employee_id: 'claude', ...overrides }
  }

  function adminApp() {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userId', ADMIN_ID)
      c.set('userRole', 'administrator')
      await next()
    })
    app.route('/api/admin/usage', adminUsage)
    return app
  }

  it('대상 회원의 연동 값이 공용 축이면 상류 질의 없이 200 + identity_shared_workstation(+ user_not_in_metrics)', async () => {
    findByIdMock.mockResolvedValue(targetRow())
    sharedFindByIdMock.mockResolvedValue(SHARED_ROW)
    const app = adminApp()

    const res = await app.request(`/api/admin/usage/users/${TARGET_ID}`, {}, { DB: {} })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.totals.total_tokens).toBe(0)
    expect(body.meta.identity_shared_workstation).toBe(true)
    expect(body.meta.user_not_in_metrics).toBe(true)
    expect(body.meta.identity_unlinked).toBeUndefined() // 미연동과 구분된다
    expect(body.meta.data_start).toBe('2026-07-28') // coverage는 그대로 읽어 정상 채운다
    expect(getUserDrilldownMock).not.toHaveBeenCalled() // 상류 호출 0회
    // 조회 시도 자체는 감사 대상이다 — 상류를 안 불렀다고 감사를 빠뜨리지 않는다.
    expect(auditRecordMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.cross_user_view', targetId: TARGET_ID
    }))
  })

  it('레지스트리 조회 실패 시 fail-open 하지 않는다 — 상류를 부르지 않고 예외가 전파된다', async () => {
    findByIdMock.mockResolvedValue(targetRow())
    sharedFindByIdMock.mockRejectedValue(new Error('D1_ERROR: connection lost'))
    const app = adminApp()
    app.onError((err, c) => c.json({ error: { code: 'INTERNAL_ERROR', message: err.message } }, 500))

    const res = await app.request(`/api/admin/usage/users/${TARGET_ID}`, {}, { DB: {} })

    expect(res.status).toBe(500)
    expect(getUserDrilldownMock).not.toHaveBeenCalled()
  })

  it('등록되지 않은 축이면 기존 경로 그대로 드릴다운을 수행한다(등록 전까지 동작 무변경)', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    getUserDrilldownMock.mockResolvedValue({
      notInMetrics: false, sharedWorkstation: false,
      rows: [{ day_at: '2026-09-01', session_count: 1, input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 10, cost_usd: 0.1 }],
      totals: { session_count: 1, input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 10, cost_usd: 0.1, active_time_seconds: 5, active_days: 1 },
      groupAccounts: [], byModel: [], unknownTypes: new Set(),
      meta: { hit: true, age_seconds: 0, ttl_seconds: 60, stale: false, fetched_at: '2026-09-04T00:00:00.000Z', refresh_throttled: false }
    })
    const app = adminApp()

    const res = await app.request(`/api/admin/usage/users/${TARGET_ID}`, {}, { DB: {} })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.meta.identity_shared_workstation).toBeUndefined()
    expect(getUserDrilldownMock).toHaveBeenCalledTimes(1)
  })
})
