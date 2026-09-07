// GET /api/usage/me 라우트 레벨 단위테스트(승인결정1, 2026-09-04) — 완료판정 항목2 "다른 사용자의
// 데이터를 볼 수 있는 경로가 없음을 테스트로 증명"의 실측 근거. server/lib/usage-prom.js는
// vi.mock으로 대체해 D1/Prometheus 네트워크 없이 라우트 코드 자체(IDOR 방지 로직)만 검증한다 —
// getUsageOverviewHybrid()에 넘어가는 인자와, 반환된 byUser Map에서 응답이 실제로 어느 키를
// 읽는지가 검증 대상이다.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const getUsageOverviewHybridMock = vi.fn()

vi.mock('../lib/usage-prom.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getUsageOverviewHybrid: (...args) => getUsageOverviewHybridMock(...args) }
})

const { default: usage } = await import('./usage.js')

const SELF_EMAIL = 'self@malgnsoft.com'

function buildHybrid(byUserEntries) {
  return {
    byUser: new Map(byUserEntries),
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
    c.set('userId', 'user-self-id')
    c.set('userRole', 'employee')
    c.set('userEmail', SELF_EMAIL)
    await next()
  })
  app.route('/api/usage', usage)
  return app
}

beforeEach(() => {
  getUsageOverviewHybridMock.mockReset()
})

describe('GET /api/usage/me — 본인 스코프 강제(IDOR 방지)', () => {
  it('쿼리에 다른 사용자 email/user_id/user_email을 실어 보내도 무시하고 항상 JWT 컨텍스트의 본인 email로만 조회한다', async () => {
    getUsageOverviewHybridMock.mockResolvedValue(buildHybrid([]))
    const app = makeApp()

    const res = await app.request(
      '/api/usage/me?email=attacker@evil.com&user_id=someone-else&user_email=victim@malgnsoft.com',
      {},
      {}
    )

    expect(res.status).toBe(200)
    expect(getUsageOverviewHybridMock).toHaveBeenCalledTimes(1)
    const [, args] = getUsageOverviewHybridMock.mock.calls[0]
    expect(args.email).toBe(SELF_EMAIL) // 쿼리 파라미터는 전혀 반영되지 않는다
  })

  it('하위 계층(getUsageOverviewHybrid)이 실수로 타인 데이터를 함께 반환해도 응답은 본인 email 키만 읽는다', async () => {
    const otherDays = new Map([['2026-09-01', { input_tokens: 999999, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, session_count: 1, cost_usd: 100 }]])
    const selfDays = new Map([['2026-09-01', { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, session_count: 1, cost_usd: 0.01 }]])
    getUsageOverviewHybridMock.mockResolvedValue(buildHybrid([
      ['victim@malgnsoft.com', { displayEmail: 'victim@malgnsoft.com', employeeName: '피해자', days: otherDays }],
      [SELF_EMAIL, { displayEmail: SELF_EMAIL, employeeName: '본인', days: selfDays }]
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

  it('from/to 형식이 잘못되면 400을 반환하고 상류를 아예 부르지 않는다', async () => {
    const app = makeApp()
    const res = await app.request('/api/usage/me?from=2026/09/01', {}, {})

    expect(res.status).toBe(400)
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
})
