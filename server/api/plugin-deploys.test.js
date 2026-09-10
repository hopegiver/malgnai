// POST /api/plugin-deploys/notify, GET /api/plugin-deploys 라우트 레벨 테스트.
// 설계 정본: docs/design/plugin-deploy-notify.md §15 체크리스트9의 최소 커버리지를 그대로 만족한다.
//
// server/dao/plugin-deploys.js는 mock하지 않는다 — node:sqlite 위에 실제 migrations/0027 DDL을
// 적용한 진짜 SQLite로 돌려서 멱등성(§8.2 ON CONFLICT DO NOTHING RETURNING)과 "재전송 시 id·
// received_at 불변"을 실물로 증명한다(server/dao/google-login-flows.test.js의 실DDL 패턴 계승).
// syncCatalog(server/lib/catalog-sync.js)만 vi.mock으로 대체해 실제 GitHub 호출을 막고 waitUntil
// 트리거 여부(§2.3 created 게이트)를 관찰한다.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const syncCatalogMock = vi.fn().mockResolvedValue({ scanned: 0 })
vi.mock('../lib/catalog-sync.js', () => ({
  syncCatalog: (...args) => syncCatalogMock(...args)
}))

const { jwtAuthMiddleware } = await import('../middleware/jwt-auth.js')
const { default: pluginDeploys } = await import('./plugin-deploys.js')

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))
const VALID_KEY = 'dev-only-test-key-at-least-32-bytes-long'
const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

// M-1 처방(전역 sync 쿨다운)이 plugin_deploys.sync_triggered_at 컬럼에 의존하므로 0028도 함께
// 적용한다 — 0027만 적용하면 UPDATE ... SET sync_triggered_at이 "no such column"으로 실패한다.
const MIGRATION_FILES = ['0027_plugin_deploys.sql', '0028_plugin_deploys_sync_cooldown.sql']

/** D1 prepare().bind().run()/.first()/.all() 인터페이스를 흉내내는 얇은 어댑터
 *  (server/dao/google-login-flows.test.js와 동일 패턴). insertIfAbsent()는 .all()로
 *  ON CONFLICT ... RETURNING 결과를 받는다 — 실 SQLite에서 그 경로가 그대로 동작하는지까지
 *  증명한다(설계 §8.2가 예고한 폴백은 이 테스트가 통과하면 불필요함이 확인된다). */
function makeSqliteDb() {
  const raw = new DatabaseSync(':memory:')
  for (const file of MIGRATION_FILES) {
    const ddl = readFileSync(MIGRATIONS_DIR + file, 'utf8')
    for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
      raw.exec(stmt)
    }
  }
  return {
    prepare(sql) {
      return {
        bind: (...args) => ({
          run: async () => {
            const info = raw.prepare(sql).run(...args)
            return { meta: { changes: info.changes } }
          },
          first: async () => raw.prepare(sql).get(...args) || null,
          all: async () => ({ results: raw.prepare(sql).all(...args) })
        })
      }
    }
  }
}

// 실제 index.js와 동일하게 jwtAuthMiddleware를 /api/*에 전역 부착한 뒤 라우터를 마운트한다 —
// GET /api/plugin-deploys가 JWT 없이 401인지(§3.2 회귀)를 프로덕션과 같은 배선으로 검증하기 위함.
function makeApp() {
  const app = new Hono()
  app.use('/api/*', jwtAuthMiddleware)
  app.route('/api/plugin-deploys', pluginDeploys)
  return app
}

function baseEnv(overrides = {}) {
  return {
    DB: makeSqliteDb(),
    PLUGIN_DEPLOY_KEY: VALID_KEY,
    JWT_SECRET: 'test-jwt-secret',
    GITHUB_TOKEN: 'unused-in-test',
    // PLUGIN_DEPLOY_RL 바인딩은 기본적으로 넣지 않는다 — 로컬/바인딩 미반영 환경의 fail-open을
    // 기본 픽스처로 삼는다(설계 §9.2, checklist9 "레이트리밋 바인딩 부재 시 통과").
    ...overrides
  }
}

// c.executionCtx.waitUntil()이 호출되므로 Hono Context가 요구하는 ExecutionContext 형태를
// 최소 구현으로 채운다 — 실 Cloudflare Workers의 waitUntil과 달리 즉시 promise를 실행만 한다.
function makeExecutionCtx() {
  const waited = []
  return { ctx: { waitUntil: (p) => waited.push(p) }, waited }
}

function notify(app, env, body, { headers = {}, executionCtx } = {}) {
  const ctx = executionCtx || makeExecutionCtx().ctx
  return app.request('/api/plugin-deploys/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  }, env, ctx)
}

function validBody(overrides = {}) {
  return {
    plugin_name: 'malgn-agent',
    version: '1.8.37',
    commit_hash: COMMIT_A,
    repository: 'malgnsoft/claude-plugins',
    deployed_at: '2026-09-10T08:12:44Z',
    ...overrides
  }
}

beforeEach(() => {
  syncCatalogMock.mockClear()
})

describe('POST /api/plugin-deploys/notify — 인증', () => {
  it('①올바른 키 → 201 + 행 생성(created:true) + waitUntil로 syncCatalog 트리거', async () => {
    const app = makeApp()
    const env = baseEnv()
    const { ctx, waited } = makeExecutionCtx()
    const res = await notify(app, env, validBody(), { headers: { 'X-Plugin-Deploy-Key': VALID_KEY }, executionCtx: ctx })
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json).toMatchObject({ accepted: true, created: true, plugin_name: 'malgn-agent', version: '1.8.37', commit_hash: COMMIT_A })
    expect(typeof json.id).toBe('string')
    expect(typeof json.received_at).toBe('string')

    // 신규 행 생성 → created===true 게이트를 통과해 waitUntil에 sync 프라미스가 들어갔다(§2.3).
    expect(waited).toHaveLength(1)
    await Promise.all(waited)
    expect(syncCatalogMock).toHaveBeenCalledTimes(1)

    // D1에 실제로 1행이 생겼는지 직접 확인(라우트 응답만이 아니라 저장소 상태로 검증).
    const row = await env.DB.prepare('SELECT * FROM plugin_deploys WHERE id = ?').bind(json.id).first()
    expect(row.plugin_name).toBe('malgn-agent')
  })

  it('②잘못된 키 → 401, message는 invalid deploy key', async () => {
    const app = makeApp()
    const res = await notify(app, baseEnv(), validBody(), { headers: { 'X-Plugin-Deploy-Key': 'wrong-key-wrong-key-wrong-key-32b' } })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error.code).toBe('UNAUTHORIZED')
    expect(json.error.message).toBe('invalid deploy key')
  })

  it('③키 헤더 누락 → 401, message는 missing X-Plugin-Deploy-Key header(②와 다른 문구로 구분)', async () => {
    const app = makeApp()
    const res = await notify(app, baseEnv(), validBody())
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error.code).toBe('UNAUTHORIZED')
    expect(json.error.message).toBe('missing X-Plugin-Deploy-Key header')
  })

  it('④시크릿 미설정 → 500(통과가 아니다, fail-closed)', async () => {
    const app = makeApp()
    const env = baseEnv({ PLUGIN_DEPLOY_KEY: undefined })
    const res = await notify(app, env, validBody(), { headers: { 'X-Plugin-Deploy-Key': VALID_KEY } })
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error.code).toBe('INTERNAL_ERROR')
    // 시크릿 값·길이 어느 것도 응답에 노출되지 않는다.
    expect(JSON.stringify(json)).not.toContain(VALID_KEY)
  })

  it('시크릿이 MIN_KEY_LENGTH(32) 미만이면 짧은 값 자체도 500(짧은 임시값이 실운영 자격증명이 되는 사고 차단)', async () => {
    const app = makeApp()
    const env = baseEnv({ PLUGIN_DEPLOY_KEY: 'too-short' })
    const res = await notify(app, env, validBody(), { headers: { 'X-Plugin-Deploy-Key': 'too-short' } })
    expect(res.status).toBe(500)
  })
})

describe('POST /api/plugin-deploys/notify — 검증(§5)', () => {
  const HEADERS = { 'X-Plugin-Deploy-Key': VALID_KEY }

  it('⑦-1 semver 형식 위반(v 접두사) → 400', async () => {
    const app = makeApp()
    const res = await notify(app, baseEnv(), validBody({ version: 'v1.8.37' }), { headers: HEADERS })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('VALIDATION_ERROR')
    expect(json.error.message).toMatch(/semver/)
  })

  it('⑦-2 commit_hash 형식 위반(짧음) → 400', async () => {
    const app = makeApp()
    const res = await notify(app, baseEnv(), validBody({ commit_hash: 'abc123' }), { headers: HEADERS })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.message).toMatch(/commit_hash/)
  })

  it('⑦-3 deployed_at 범위 이탈(미래 24h 초과) → 400', async () => {
    const app = makeApp()
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const res = await notify(app, baseEnv(), validBody({ deployed_at: future }), { headers: HEADERS })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.message).toMatch(/deployed_at/)
  })

  it('deployed_at 길이 초과(Date.parse의 관대한 파싱을 노린 3000자 문자열) → 400(m-2)', async () => {
    // security 정밀검토 m-2가 지적한 실제 페이로드 형태 — Date.parse는 이 형식을 통과시키므로
    // 형식 검사만으로는 막히지 않고, 길이 상한이 있어야 막힌다.
    const app = makeApp()
    const malicious = 'Sep 10 2026 00:00:00 GMT+0000 (' + 'a'.repeat(3000) + ')'
    const res = await notify(app, baseEnv(), validBody({ deployed_at: malicious }), { headers: HEADERS })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.message).toMatch(/deployed_at/)
  })

  it('deployed_at이 짧아도 Date.parse가 실패하는 비ISO 문자열이면 400', async () => {
    const app = makeApp()
    const res = await notify(app, baseEnv(), validBody({ deployed_at: 'not-a-timestamp' }), { headers: HEADERS })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.message).toMatch(/deployed_at/)
  })

  it('deployed_at이 정규화되어 저장된다(밀리초 없는 입력 → .000Z가 붙은 표준형, m-2)', async () => {
    const app = makeApp()
    const env = baseEnv()
    const body = validBody({ commit_hash: 'f'.repeat(40), deployed_at: '2026-09-10T08:12:44Z' })
    const res = await notify(app, env, body, { headers: HEADERS })
    expect(res.status).toBe(201)
    const json = await res.json()
    const row = await env.DB.prepare('SELECT deployed_at FROM plugin_deploys WHERE id = ?').bind(json.id).first()
    expect(row.deployed_at).toBe('2026-09-10T08:12:44.000Z')
    expect(row.deployed_at).not.toBe(body.deployed_at) // 입력 원문 그대로가 아니라 정규화됐다.
  })

  it('plugin_name 형식 위반(대문자 포함) → 400', async () => {
    const app = makeApp()
    const res = await notify(app, baseEnv(), validBody({ plugin_name: 'Malgn-Agent' }), { headers: HEADERS })
    expect(res.status).toBe(400)
  })

  it('본문 4KB 초과(Content-Length) → 400', async () => {
    const app = makeApp()
    const res = await app.request('/api/plugin-deploys/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '5000', ...HEADERS }
    }, baseEnv())
    expect(res.status).toBe(400)
  })

  it('Content-Length 헤더가 실제 크기보다 작게 와도(부재와 동치인 경로) 실제 바이트 기준으로 400(m-1)', async () => {
    // Number(undefined||0)=0, Number('abc')=NaN처럼 사전검사가 통과해버리는 값을 흉내낸다 —
    // 헤더가 실제보다 훨씬 작은 값을 주장해도(또는 아예 없어도) 사전검사만으로는 막히지 않는다는
    // 것이 원래 취약점이었다. 실제 본문은 4096바이트를 넘는 유효 JSON이다.
    const app = makeApp()
    const bigRepository = 'malgnsoft/' + 'a'.repeat(4090)
    const body = JSON.stringify(validBody({ repository: bigRepository }))
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(4096)
    const res = await app.request('/api/plugin-deploys/notify', {
      method: 'POST',
      // content-length를 거짓으로 작게 선언 — 사전검사(Number(...)>4096)를 통과시키려는 시도.
      headers: { 'content-type': 'application/json', 'content-length': '10', ...HEADERS },
      body
    }, baseEnv())
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.message).toMatch(/exceeds 4096 bytes/)
  })

  it('repository가 형식 위반이면 400(미제공과 다르게 취급 — null vs undefined, §5.3)', async () => {
    const app = makeApp()
    const res = await notify(app, baseEnv(), validBody({ repository: 'not-a-slug' }), { headers: HEADERS })
    expect(res.status).toBe(400)
  })

  it('repository 미제공(선택 필드)은 400이 아니라 201로 통과하고 NULL 저장', async () => {
    const app = makeApp()
    const env = baseEnv()
    const body = validBody({ commit_hash: 'c'.repeat(40) })
    delete body.repository
    const res = await notify(app, env, body, { headers: HEADERS })
    expect(res.status).toBe(201)
    const json = await res.json()
    const row = await env.DB.prepare('SELECT repository FROM plugin_deploys WHERE id = ?').bind(json.id).first()
    expect(row.repository).toBeNull()
  })

  it('repository가 GitHub URL 형태로 와도 owner/repo로 정규화해 저장(§5.3)', async () => {
    const app = makeApp()
    const env = baseEnv()
    const body = validBody({ commit_hash: 'd'.repeat(40), repository: 'https://github.com/malgnsoft/claude-plugins.git' })
    const res = await notify(app, env, body, { headers: HEADERS })
    expect(res.status).toBe(201)
    const json = await res.json()
    const row = await env.DB.prepare('SELECT repository FROM plugin_deploys WHERE id = ?').bind(json.id).first()
    expect(row.repository).toBe('malgnsoft/claude-plugins')
  })

  it('deployed_at 생략 시 400이 아니라 서버 수신 시각으로 채워 201', async () => {
    const app = makeApp()
    const body = validBody({ commit_hash: 'e'.repeat(40) })
    delete body.deployed_at
    const res = await notify(app, baseEnv(), body, { headers: HEADERS })
    expect(res.status).toBe(201)
  })
})

describe('POST /api/plugin-deploys/notify — 멱등성(§8)', () => {
  const HEADERS = { 'X-Plugin-Deploy-Key': VALID_KEY }

  it('⑤동일 (plugin,version,commit) 재전송 → 200 + created:false + id/received_at 최초값 유지 + 행 1개', async () => {
    const app = makeApp()
    const env = baseEnv()
    const body = validBody()

    const first = await notify(app, env, body, { headers: HEADERS })
    expect(first.status).toBe(201)
    const firstJson = await first.json()

    const second = await notify(app, env, body, { headers: HEADERS })
    expect(second.status).toBe(200)
    const secondJson = await second.json()
    expect(secondJson.created).toBe(false)
    expect(secondJson.id).toBe(firstJson.id)
    expect(secondJson.received_at).toBe(firstJson.received_at)

    const { results } = await env.DB.prepare(
      'SELECT * FROM plugin_deploys WHERE plugin_name = ? AND version = ? AND commit_hash = ?'
    ).bind(body.plugin_name, body.version, body.commit_hash).all()
    expect(results).toHaveLength(1)

    // 최초(created:true) 1회만 syncCatalog를 유발하고, 재전송(created:false)은 추가로 유발하지
    // 않는다(§2.3 재시도 증폭 차단) — 그래서 두 번 호출했는데도 여전히 1회여야 한다.
    expect(syncCatalogMock).toHaveBeenCalledTimes(1)
  })

  it('⑥같은 버전, 다른 커밋(태그 재작성/force-push) → 201 새 행', async () => {
    const app = makeApp()
    const env = baseEnv()
    const first = await notify(app, env, validBody({ commit_hash: COMMIT_A }), { headers: HEADERS })
    expect(first.status).toBe(201)

    const second = await notify(app, env, validBody({ commit_hash: COMMIT_B }), { headers: HEADERS })
    expect(second.status).toBe(201)
    const secondJson = await second.json()
    expect(secondJson.commit_hash).toBe(COMMIT_B)

    const { results } = await env.DB.prepare(
      'SELECT * FROM plugin_deploys WHERE plugin_name = ? AND version = ?'
    ).bind('malgn-agent', '1.8.37').all()
    expect(results).toHaveLength(2)
  })

  it('다른 버전은 별개 201 새 행', async () => {
    const app = makeApp()
    const env = baseEnv()
    await notify(app, env, validBody({ version: '1.8.37' }), { headers: HEADERS })
    const res = await notify(app, env, validBody({ version: '1.8.38', commit_hash: COMMIT_B }), { headers: HEADERS })
    expect(res.status).toBe(201)
  })
})

describe('POST /api/plugin-deploys/notify — sync 쿨다운 게이트(security 정밀검토 M-1)', () => {
  const HEADERS = { 'X-Plugin-Deploy-Key': VALID_KEY }

  it('쿨다운 창 안의 두 번째 신규 배포(다른 version) → 행은 생성(201)되지만 sync는 트리거되지 않음', async () => {
    const app = makeApp()
    const env = baseEnv()

    const first = await notify(app, env, validBody({ version: '1.8.37', commit_hash: COMMIT_A }), { headers: HEADERS })
    expect(first.status).toBe(201)
    expect(syncCatalogMock).toHaveBeenCalledTimes(1)

    // 같은 창(실질적으로 즉시) 안에서 다른 version/commit — created 게이트는 통과하지만(신규
    // 튜플이므로 201) 쿨다운 게이트가 sync 트리거를 막아야 한다.
    const second = await notify(app, env, validBody({ version: '1.8.38', commit_hash: COMMIT_B }), { headers: HEADERS })
    expect(second.status).toBe(201)
    const secondJson = await second.json()
    expect(secondJson.created).toBe(true)
    expect(syncCatalogMock).toHaveBeenCalledTimes(1) // 여전히 1회 — 두 번째는 스킵됐다.

    // D1에는 두 번째 행이 실제로 생겼는지도 확인(응답만이 아니라 저장소 상태로 검증).
    const { results } = await env.DB.prepare('SELECT * FROM plugin_deploys').bind().all()
    expect(results).toHaveLength(2)

    // 스킵된 행의 sync_triggered_at은 NULL로 남는다(실제로 트리거되지 않았다는 증거).
    const secondRow = await env.DB.prepare('SELECT sync_triggered_at FROM plugin_deploys WHERE id = ?').bind(secondJson.id).first()
    expect(secondRow.sync_triggered_at).toBeNull()
  })

  it('쿨다운 창 밖(10분 경과 후) → sync가 다시 트리거됨', async () => {
    vi.useFakeTimers()
    try {
      const app = makeApp()
      const env = baseEnv()
      vi.setSystemTime(new Date('2026-09-10T00:00:00.000Z'))

      const first = await notify(app, env, validBody({ version: '1.8.37', commit_hash: COMMIT_A, deployed_at: undefined }), { headers: HEADERS })
      expect(first.status).toBe(201)
      expect(syncCatalogMock).toHaveBeenCalledTimes(1)

      // +11분 — SYNC_COOLDOWN_MS(10분) 밖으로 시스템 시각을 이동시킨다.
      vi.setSystemTime(new Date('2026-09-10T00:11:00.000Z'))

      const second = await notify(app, env, validBody({ version: '1.8.38', commit_hash: COMMIT_B, deployed_at: undefined }), { headers: HEADERS })
      expect(second.status).toBe(201)
      expect(syncCatalogMock).toHaveBeenCalledTimes(2) // 쿨다운이 풀렸으니 다시 트리거된다.

      const secondJson = await second.json()
      const secondRow = await env.DB.prepare('SELECT sync_triggered_at FROM plugin_deploys WHERE id = ?').bind(secondJson.id).first()
      expect(secondRow.sync_triggered_at).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('쿨다운에 걸려 skip돼도 알림 수신 자체는 성공(2xx)이다 — 응답 계약은 바뀌지 않는다', async () => {
    const app = makeApp()
    const env = baseEnv()
    await notify(app, env, validBody({ version: '1.8.37', commit_hash: COMMIT_A }), { headers: HEADERS })
    const second = await notify(app, env, validBody({ version: '1.8.38', commit_hash: COMMIT_B }), { headers: HEADERS })
    expect(second.status).toBe(201)
    const json = await second.json()
    expect(json.accepted).toBe(true)
    expect(json).not.toHaveProperty('sync_triggered_at') // 부수효과는 응답 바디에 노출되지 않는다(§6.4).
  })
})

describe('POST /api/plugin-deploys/notify — 레이트리밋(§9)', () => {
  it('PLUGIN_DEPLOY_RL 바인딩 부재 시 통과(fail-open, 로컬/미반영 환경)', async () => {
    const app = makeApp()
    const env = baseEnv() // PLUGIN_DEPLOY_RL 없음
    const res = await notify(app, env, validBody(), { headers: { 'X-Plugin-Deploy-Key': VALID_KEY } })
    expect(res.status).toBe(201)
  })

  it('바인딩이 있고 초과 판정을 내리면 429 + Retry-After: 60', async () => {
    const app = makeApp()
    const env = baseEnv({ PLUGIN_DEPLOY_RL: { limit: vi.fn().mockResolvedValue({ success: false }) } })
    const res = await notify(app, env, validBody(), { headers: { 'X-Plugin-Deploy-Key': VALID_KEY } })
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    const json = await res.json()
    expect(json.error.code).toBe('RATE_LIMITED')
  })

  it('레이트리밋은 키 비교보다 먼저 검사한다 — 초과 시 잘못된 키라도 429(401 아님, §9.2 순서)', async () => {
    const app = makeApp()
    const env = baseEnv({ PLUGIN_DEPLOY_RL: { limit: vi.fn().mockResolvedValue({ success: false }) } })
    const res = await notify(app, env, validBody(), { headers: { 'X-Plugin-Deploy-Key': 'totally-wrong-key-value-32-bytes' } })
    expect(res.status).toBe(429)
  })
})

describe('GET /api/plugin-deploys — 조회(JWT) + §3.2 PUBLIC_PATHS 회귀', () => {
  it('⑧JWT 없이는 401(PUBLIC_PATHS 오염이 없다는 회귀 테스트)', async () => {
    const app = makeApp()
    const res = await app.request('/api/plugin-deploys', {}, baseEnv())
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error.code).toBe('UNAUTHORIZED')
  })

  it('X-Plugin-Deploy-Key를 실어도 JWT가 없으면 여전히 401(조회는 CI 키 축이 아니다)', async () => {
    const app = makeApp()
    const res = await app.request('/api/plugin-deploys', { headers: { 'X-Plugin-Deploy-Key': VALID_KEY } }, baseEnv())
    expect(res.status).toBe(401)
  })
})
