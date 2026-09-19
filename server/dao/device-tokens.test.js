// server/dao/device-tokens.js 단위테스트 — device_token 계정상태 게이트 회귀 잠금
// (docs/security/device-token-revocation-investigation-2026-09-19.md §5 후보A).
//
// users/device_tokens는 mock하지 않는다 — node:sqlite 위에 실 마이그레이션 전체(0001~0030)를
// 그대로 적용한 진짜 SQLite로 findActiveByHash의 JOIN이 실제로 disabled 계정을 걸러내는지,
// 고아 user_id(존재하지 않는 사용자)를 걸러내는지를 실물 스키마·CHECK 제약 위에서 증명한다
// (server/dao/google-login-flows.test.js·server/lib/rotating-token.test.js의 실DDL 패턴 계승).
// "401이 나온다"만 찍는 얕은 테스트가 되지 않도록, 반환된 row shape(호출부 mcp/device-auth.js가
// 읽는 필드들)까지 함께 확인한다.
import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  findActiveByHash, insert, revoke, buildRevokeAllForUserStatement, countActiveForUser
} from './device-tokens.js'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

/** migrations/ 디렉터리의 *.sql 전체를 파일명(=번호) 오름차순으로 그대로 적용한다 — 목록을
 *  하드코딩하지 않아 새 마이그레이션이 추가돼도 이 테스트가 실배포 스키마와 갈리지 않는다.
 *  raw.exec(전체 파일 텍스트)를 쓴다(rotating-token.test.js와 동일 이유 — 0001의 FTS 트리거가
 *  세미콜론을 포함한 BEGIN...END 복합문이라 ';'로 단순 분리하면 잘린다). */
function makeSqliteDb() {
  const raw = new DatabaseSync(':memory:')
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    raw.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'))
  }
  return {
    raw,
    prepare(sql) {
      return {
        bind: (...args) => ({
          run: async () => {
            const info = raw.prepare(sql).run(...args)
            return { meta: { changes: info.changes } }
          },
          first: async () => {
            const row = raw.prepare(sql).get(...args)
            return row || null
          },
          all: async () => {
            const rows = raw.prepare(sql).all(...args)
            return { results: rows }
          }
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

const NOW = '2026-09-19T00:00:00.000Z'

beforeEach(() => {
  // no-op — 각 테스트가 makeSqliteDb()로 독립된 인메모리 DB를 새로 만든다.
})

describe('findActiveByHash — users.status 게이트(후보A)', () => {
  it('active 사용자의 active device_token → row 반환(호출부가 읽는 필드 shape 유지)', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-active', email: 'active@malgnsoft.com', status: 'active' })
    const created = await insert(db, { userId: 'user-active', deviceId: 'device-1', deviceName: 'mac', tokenHash: 'hash-active' })

    const token = await findActiveByHash(db, 'hash-active')

    expect(token).toBeTruthy()
    expect(token.id).toBe(created.id)
    expect(token.user_id).toBe('user-active')
    expect(token.device_id).toBe('device-1')
    expect(token.status).toBe('active')
    expect(token.expires_at).toBeNull()
    expect(token.scopes).toBe('project.read,project.write,telemetry.write')
  })

  it('disabled 사용자의 active device_token → undefined(계정 비활성화가 잔존 토큰을 무효화한다)', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-disabled', email: 'gone@malgnsoft.com', status: 'disabled' })
    await insert(db, { userId: 'user-disabled', deviceId: 'device-2', deviceName: 'mac', tokenHash: 'hash-disabled' })

    const token = await findActiveByHash(db, 'hash-disabled')

    expect(token).toBeFalsy()
  })

  it('users에 없는 고아 user_id의 device_token → undefined(INNER JOIN이 자동 배제)', async () => {
    const db = makeSqliteDb()
    // insertUser를 호출하지 않는다 — user_id가 users 테이블에 존재하지 않는 상태를 그대로 재현.
    await insert(db, { userId: 'user-does-not-exist', deviceId: 'device-3', deviceName: 'mac', tokenHash: 'hash-orphan' })

    const token = await findActiveByHash(db, 'hash-orphan')

    expect(token).toBeFalsy()
  })

  it('active 사용자라도 device_token 자체가 revoked면 여전히 undefined(기존 동작 회귀 없음)', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-active-2', email: 'active2@malgnsoft.com', status: 'active' })
    const created = await insert(db, { userId: 'user-active-2', deviceId: 'device-4', deviceName: 'mac', tokenHash: 'hash-revoked' })
    await revoke(db, created.id)

    const token = await findActiveByHash(db, 'hash-revoked')

    expect(token).toBeFalsy()
  })

  it('토큰 해시가 애초에 존재하지 않으면 undefined', async () => {
    const db = makeSqliteDb()
    const token = await findActiveByHash(db, 'hash-never-issued')
    expect(token).toBeFalsy()
  })
})

describe('buildRevokeAllForUserStatement — 계정 비활성화 캐스케이드(후보B)', () => {
  it('해당 user의 active device_token 전부를 revoked로 바꾸고, 다른 user의 토큰은 건드리지 않는다', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-a', email: 'a@malgnsoft.com' })
    insertUser(db, { id: 'user-b', email: 'b@malgnsoft.com' })
    await insert(db, { userId: 'user-a', deviceId: 'd1', tokenHash: 'h1' })
    await insert(db, { userId: 'user-a', deviceId: 'd2', tokenHash: 'h2' })
    await insert(db, { userId: 'user-b', deviceId: 'd3', tokenHash: 'h3' })

    const stmt = buildRevokeAllForUserStatement(db, 'user-a')
    const result = await stmt.run()

    expect(result.meta.changes).toBe(2)
    const remainingA1 = await findActiveByHash(db, 'h1')
    const remainingA2 = await findActiveByHash(db, 'h2')
    const remainingB = await findActiveByHash(db, 'h3')
    expect(remainingA1).toBeFalsy()
    expect(remainingA2).toBeFalsy()
    expect(remainingB).toBeTruthy() // user-b 토큰은 active 사용자 소유라 영향 없음

    const rowH1 = db.raw.prepare('SELECT status, revoked_at FROM device_tokens WHERE token_hash = ?').get('h1')
    expect(rowH1.status).toBe('revoked')
    expect(rowH1.revoked_at).not.toBeNull()
  })

  it('이미 revoked인 토큰은 다시 건드리지 않는다(멱등 — WHERE status=\'active\' 필터)', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-a', email: 'a@malgnsoft.com' })
    const created = await insert(db, { userId: 'user-a', deviceId: 'd1', tokenHash: 'h1' })
    await revoke(db, created.id)
    const before = db.raw.prepare('SELECT revoked_at FROM device_tokens WHERE id = ?').get(created.id)

    const result = await buildRevokeAllForUserStatement(db, 'user-a').run()
    const after = db.raw.prepare('SELECT revoked_at FROM device_tokens WHERE id = ?').get(created.id)

    expect(result.meta.changes).toBe(0)
    expect(after.revoked_at).toBe(before.revoked_at) // 재실행이 revoked_at을 덮어쓰지 않는다
  })

  it('device_token이 0건인 사용자에 대해 실행해도 changes=0으로 안전하게 끝난다', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-no-tokens', email: 'notoken@malgnsoft.com' })
    const result = await buildRevokeAllForUserStatement(db, 'user-no-tokens').run()
    expect(result.meta.changes).toBe(0)
  })
})

describe('countActiveForUser — 캐스케이드 감사로그 사전 카운트', () => {
  it('active 토큰 수만 카운트한다(revoked는 제외)', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-a', email: 'a@malgnsoft.com' })
    await insert(db, { userId: 'user-a', deviceId: 'd1', tokenHash: 'h1' })
    const revoked = await insert(db, { userId: 'user-a', deviceId: 'd2', tokenHash: 'h2' })
    await revoke(db, revoked.id)

    expect(await countActiveForUser(db, 'user-a')).toBe(1)
  })

  it('토큰이 없는 사용자는 0', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-a', email: 'a@malgnsoft.com' })
    expect(await countActiveForUser(db, 'user-a')).toBe(0)
  })
})

describe('재활성화 시나리오 — disabled → active 복귀', () => {
  it('재활성화 후에도 disable 시점에 캐스케이드로 폐기된 옛 device_token은 복구되지 않는다(재페어링 필요, 의도된 동작)', async () => {
    const db = makeSqliteDb()
    insertUser(db, { id: 'user-a', email: 'a@malgnsoft.com', status: 'active' })
    await insert(db, { userId: 'user-a', deviceId: 'd1', tokenHash: 'old-hash' })

    // 관리자가 비활성화 → 캐스케이드 폐기(admin-users.js가 하는 일을 이 테스트에서는 DAO
    // 호출로 직접 재현한다).
    db.raw.prepare("UPDATE users SET status='disabled', updated_at=? WHERE id=?").run(NOW, 'user-a')
    await buildRevokeAllForUserStatement(db, 'user-a').run()

    expect(await findActiveByHash(db, 'old-hash')).toBeFalsy()

    // 관리자가 재활성화.
    db.raw.prepare("UPDATE users SET status='active', updated_at=? WHERE id=?").run(NOW, 'user-a')

    // 옛 토큰은 여전히 무효(자동 복구 없음) — 사용자는 새로 pair-approve/OAuth 인가를 받아야 한다.
    expect(await findActiveByHash(db, 'old-hash')).toBeFalsy()

    // 재페어링으로 새로 발급된 토큰은 정상 동작한다.
    await insert(db, { userId: 'user-a', deviceId: 'd2', tokenHash: 'new-hash' })
    const newToken = await findActiveByHash(db, 'new-hash')
    expect(newToken).toBeTruthy()
    expect(newToken.user_id).toBe('user-a')
  })
})
