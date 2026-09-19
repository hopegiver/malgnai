// PATCH /api/admin/users/:id — 계정 비활성화 캐스케이드의 "부분 실패 없음" 주장을 실물 SQLite
// 트랜잭션으로 증명한다(docs/security/device-token-revocation-investigation-2026-09-19.md §5
// 후보B 트레이드오프④, §완료판정 3). server/api/admin-users.test.js는 c.env.DB.batch를 vi.fn()으로
// 대체해 "어떤 statement가 배열에 담기는가"만 확인하므로, batch가 실제로 원자적인지는 이 파일이
// node:sqlite(BEGIN/COMMIT/ROLLBACK)로 별도 증명한다 — mock만으로는 "부분 실패 처리를 구현했다"는
// 주장이 빈 깡통이 될 수 있다.
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as usersDao from '../dao/users.js'
import * as deviceTokensDao from '../dao/device-tokens.js'
import * as oauthRefreshTokensDao from '../dao/oauth-refresh-tokens.js'
import * as refreshTokensDao from '../dao/refresh-tokens.js'
import * as auditLogsDao from '../dao/audit-logs.js'

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
    },
    // D1 db.batch()를 흉내낸다 — Cloudflare 문서상 batch는 단일 트랜잭션이라 어느 statement든
    // 실패하면 전체가 롤백된다(admin-users.js 주석이 근거로 삼는 바로 그 보장). node:sqlite로
    // 진짜 BEGIN/COMMIT/ROLLBACK을 돌려 이 보장을 그대로 재현한다.
    async batch(statements) {
      raw.exec('BEGIN')
      try {
        const results = []
        for (const stmt of statements) {
          results.push(await stmt.run())
        }
        raw.exec('COMMIT')
        return results
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      }
    }
  }
}

function insertUser(db, { id, status = 'active', role = 'employee', email }) {
  db.raw.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, 'Test User', 'x', ?, ?, ?, ?)`
  ).run(id, email, role, status, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
}

/** admin-users.js PATCH /:id가 status:'disabled' 전환 시 실제로 조립하는 것과 동일한 statement
 *  배열을 재현한다(라우트 자체를 통하지 않고 DAO 원자성만 격리 검증하기 위해). */
function buildDisableCascadeStatements(db, userId) {
  return [
    usersDao.buildUpdateRoleStatusStatement(db, userId, { status: 'disabled' }),
    auditLogsDao.buildRecordStatement(db, {
      actorUserId: 'admin-1', action: 'user.role_changed', targetType: 'user', targetId: userId,
      metadata: { before: { status: 'active' }, after: { status: 'disabled' } }
    }).stmt,
    deviceTokensDao.buildRevokeAllForUserStatement(db, userId),
    oauthRefreshTokensDao.buildRevokeAllForUserStatement(db, userId, 'device_revoked'),
    refreshTokensDao.buildRevokeAllForUserStatement(db, userId, 'logout'),
    auditLogsDao.buildRecordStatement(db, {
      actorUserId: 'admin-1', action: 'device_token.revoked', targetType: 'user', targetId: userId,
      metadata: { reason: 'user_disabled', device_token_count: 1 }
    }).stmt
  ]
}

describe('PATCH /api/admin/users/:id 캐스케이드 — 실물 트랜잭션 원자성(부분 실패 없음, §완료판정 3)', () => {
  it('정상 경로 — 6개 statement가 한 트랜잭션으로 커밋되고, users.status + 3개 폐기 테이블이 전부 반영된다', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-1', email: 'u1@malgnsoft.com', status: 'active' })
    await deviceTokensDao.insert(db, { userId: 'user-1', deviceId: 'd1', tokenHash: 'device-hash' })
    const rt = await import('../dao/refresh-tokens.js')
    await rt.insert(db, { userId: 'user-1', tokenHash: 'web-refresh-hash', expiresAt: '2027-01-01T00:00:00.000Z' })

    await db.batch(buildDisableCascadeStatements(db, 'user-1'))

    const user = db.raw.prepare('SELECT status FROM users WHERE id = ?').get('user-1')
    const deviceToken = db.raw.prepare('SELECT status FROM device_tokens WHERE user_id = ?').get('user-1')
    const refreshToken = db.raw.prepare('SELECT status, revoke_reason FROM refresh_tokens WHERE user_id = ?').get('user-1')
    const auditCount = db.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE target_id = ?").get('user-1')

    expect(user.status).toBe('disabled')
    expect(deviceToken.status).toBe('revoked')
    expect(refreshToken.status).toBe('revoked')
    expect(refreshToken.revoke_reason).toBe('logout')
    expect(auditCount.n).toBe(2) // user.role_changed + device_token.revoked
  })

  it('캐스케이드 중 한 statement가 CHECK 제약을 위반해 실패하면 users.status 변경도 함께 롤백된다(반쪽 상태 불가능)', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-2', email: 'u2@malgnsoft.com', status: 'active' })
    await deviceTokensDao.insert(db, { userId: 'user-2', deviceId: 'd1', tokenHash: 'device-hash-2' })

    const statements = buildDisableCascadeStatements(db, 'user-2')
    // 실패 주입 — audit_logs.action CHECK 화이트리스트 밖의 값을 강제로 만들어 배치 중간에서
    // SQLITE_CONSTRAINT를 던지게 한다(users UPDATE·device_tokens 폐기는 이미 앞 statement로
    // 실행된 뒤라는 점이 핵심 — 그런데도 트랜잭션이므로 최종 결과는 전부 되돌아가야 한다).
    statements[5] = db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('audit-bad', 'admin-1', 'not_a_real_action', 'user', 'user-2', '{}', '2026-09-19T00:00:00.000Z')

    await expect(db.batch(statements)).rejects.toThrow()

    const user = db.raw.prepare('SELECT status FROM users WHERE id = ?').get('user-2')
    const deviceToken = db.raw.prepare('SELECT status FROM device_tokens WHERE user_id = ?').get('user-2')

    // 핵심 단언 — 캐스케이드 폐기 실패 시 "users는 이미 disabled로 커밋됐는데 토큰은 살아있는"
    // 상태(보고서 §5 후보B 트레이드오프④가 지적한 그 위험)가 존재하지 않는다. 트랜잭션 전체가
    // 롤백돼 users.status는 여전히 'active'다.
    expect(user.status).toBe('active')
    expect(deviceToken.status).toBe('active')
  })
})
