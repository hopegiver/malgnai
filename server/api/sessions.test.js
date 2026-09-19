// POST /api/sessions 인증축 회귀테스트(docs/security/device-token-revocation-investigation-2026-09-19.md
// §5 완료판정 "POST /api/sessions 동일"). 이 라우트는 mcp/device-auth.js의 deviceAuthMiddleware를
// 그대로 재사용한다(sessions.js 상단 주석) — 그 재사용이 실제로 계정상태 게이트까지 함께 물려받는지
// 라우트 레벨에서 실물 D1(node:sqlite)로 증명한다. 인증 축과 무관한 관심사(project 바인딩·sessions
// upsert·usage_daily 재집계)는 mock으로 대체해 이 파일의 관심사를 좁힌다.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const findByUserAndRepositoryKeyMock = vi.fn()
vi.mock('../dao/projects.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, findByUserAndRepositoryKey: (...args) => findByUserAndRepositoryKeyMock(...args) }
})

const upsertFinalMock = vi.fn()
vi.mock('../dao/sessions.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, upsertFinal: (...args) => upsertFinalMock(...args) }
})

const recomputeUsageDailyMock = vi.fn()
vi.mock('../lib/usage-daily.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, recomputeUsageDaily: (...args) => recomputeUsageDailyMock(...args) }
})

const { default: sessionsRouter } = await import('./sessions.js')
const { insert: insertDeviceToken } = await import('../dao/device-tokens.js')

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

function makeSqliteDb() {
  const raw = new DatabaseSync(':memory:')
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) raw.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'))
  return {
    raw,
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

function insertUser(db, { id, status = 'active', email }) {
  db.raw.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, 'Test User', 'x', 'employee', ?, ?, ?)`
  ).run(id, email, status, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
}

function makeApp() {
  const app = new Hono()
  app.route('/api/sessions', sessionsRouter)
  return app
}

function postSessions(db, body, headers = {}) {
  const app = makeApp()
  return app.request(
    '/api/sessions',
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
    { DB: db }
  )
}

function validBody(overrides = {}) {
  return {
    claude_session_id: 'sess-1',
    started_at: '2026-09-19T00:00:00.000Z',
    input_tokens: 100,
    output_tokens: 50,
    ...overrides
  }
}

beforeEach(() => {
  findByUserAndRepositoryKeyMock.mockReset().mockResolvedValue(null)
  upsertFinalMock.mockReset().mockResolvedValue(undefined)
  recomputeUsageDailyMock.mockReset().mockResolvedValue(true)
})

describe('POST /api/sessions — device_token 계정상태 게이트', () => {
  it('Authorization 헤더 없음 → 401 UNAUTHORIZED, sessions upsert 시도 안 함', async () => {
    const db = makeSqliteDb()
    const res = await postSessions(db, validBody())
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
    expect(upsertFinalMock).not.toHaveBeenCalled()
  })

  it('disabled 사용자 소유 device_token → 401(계정 비활성화가 이 축도 함께 막는다)', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-disabled', email: 'gone@malgnsoft.com', status: 'disabled' })
    await insertDeviceToken(db, { userId: 'user-disabled', deviceId: 'device-1', tokenHash: await sha256('raw-disabled') })

    const res = await postSessions(db, validBody(), { Authorization: 'Bearer raw-disabled' })

    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
    expect(upsertFinalMock).not.toHaveBeenCalled()
    expect(recomputeUsageDailyMock).not.toHaveBeenCalled()
  })

  it('active 사용자 소유 device_token → 200 accepted(회귀 없음 — 정상 사용자는 영향받지 않는다)', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-active', email: 'active@malgnsoft.com', status: 'active' })
    await insertDeviceToken(db, { userId: 'user-active', deviceId: 'device-1', tokenHash: await sha256('raw-active') })

    const res = await postSessions(db, validBody(), { Authorization: 'Bearer raw-active' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ accepted: true })
    expect(upsertFinalMock).toHaveBeenCalledTimes(1)
    expect(upsertFinalMock.mock.calls[0][1].userId).toBe('user-active')
    expect(recomputeUsageDailyMock).toHaveBeenCalledTimes(1)
  })

  it('users에 없는 고아 user_id의 device_token → 401', async () => {
    const db = makeSqliteDb()
    await insertDeviceToken(db, { userId: 'user-does-not-exist', deviceId: 'device-1', tokenHash: await sha256('raw-orphan') })

    const res = await postSessions(db, validBody(), { Authorization: 'Bearer raw-orphan' })

    expect(res.status).toBe(401)
    expect(upsertFinalMock).not.toHaveBeenCalled()
  })

  it('device_token 자체가 만료되면 active 사용자라도 401(기존 시간만료 동작 회귀 없음)', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-active', email: 'active@malgnsoft.com', status: 'active' })
    await insertDeviceToken(db, {
      userId: 'user-active', deviceId: 'device-1', tokenHash: await sha256('raw-expired'),
      expiresAt: '2020-01-01T00:00:00.000Z'
    })

    const res = await postSessions(db, validBody(), { Authorization: 'Bearer raw-expired' })
    expect(res.status).toBe(401)
  })
})

async function sha256(raw) {
  const { sha256Hex } = await import('../lib/tokens.js')
  return sha256Hex(raw)
}
