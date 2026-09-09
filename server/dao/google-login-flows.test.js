// server/dao/google-login-flows.js 단위테스트 — D1 없이 SQL 문자열·바인딩 순서·changes 매핑을
// 검증한다(admin-users.js 등 이 저장소 기존 DAO 테스트가 없는 영역이라 이 파일이 최초 — 자체
// SQL 스텁으로 진짜 predicate 텍스트를 확인해 "그냥 mock이라 통과"가 아니게 한다).
// 실제 SQLite 실행(파티션·CHECK 제약 등)은 로컬 D1 마이그레이션 적용으로 별도 검증됨(§완료판정 4).
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  insert, findByState, claim, markFailedIfPending, markFailedOwned, setHandoff, findByHandoffHash,
  consumeHandoff, deleteExpiredBefore
} from './google-login-flows.js'

/** db.prepare(sql).bind(...args).run()/.first() 호출을 그대로 기록하는 스텁. */
function makeDb({ runResult = { meta: { changes: 1 } }, firstResult = null } = {}) {
  const calls = []
  const db = {
    prepare(sql) {
      return {
        bind: (...args) => {
          calls.push({ sql, args })
          return {
            run: async () => runResult,
            first: async () => firstResult
          }
        }
      }
    }
  }
  return { db, calls }
}

// --- node:sqlite 기반 실제 DDL 위 상태전이 검증(M2 회귀 잠금 전용) ---------------------------
// SQL 문자열 스텁(makeDb)은 WHERE 절 텍스트만 확인할 뿐 실제 상태 전이(다른 행을 덮어쓰는지)는
// 검증하지 못한다 — security의 repro-markfailed-stomp.mjs가 실제 DDL+DAO로 재현한 시나리오를
// 그대로 이식해, "다른 요청이 claim()한 authorized 행을 pre-claim 실패가 덮어쓰지 않는다"를
// 수정 전 코드에서는 실패하고 수정 후 코드에서는 통과하는 형태로 잠근다.
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

function makeSqliteDb() {
  const raw = new DatabaseSync(':memory:')
  // 0024가 google_login_flows CREATE TABLE 정본이다(리뷰 §M2 근거와 동일 파일).
  const ddl = readFileSync(MIGRATIONS_DIR + '0024_google_login_flows.sql', 'utf8')
  for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
    raw.exec(stmt)
  }
  // D1 prepare().bind(...).run()/.first() 인터페이스를 흉내내는 아주 얇은 어댑터.
  return {
    prepare(sql) {
      return {
        bind: (...args) => ({
          run: async () => {
            const stmt = raw.prepare(sql)
            const info = stmt.run(...args)
            return { meta: { changes: info.changes } }
          },
          first: async () => {
            const stmt = raw.prepare(sql)
            const row = stmt.get(...args)
            return row || null
          }
        })
      }
    }
  }
}

describe('insert — /start INSERT', () => {
  it('status는 항상 pending으로 고정, 바인딩 순서가 컬럼 순서와 일치', async () => {
    const { db, calls } = makeDb()
    const row = await insert(db, {
      state: 's1', bindingHash: 'bh1', nonce: 'n1', codeVerifier: 'cv1',
      redirectPath: '/usage', mode: 'silent', expiresAt: '2026-01-01T00:10:00.000Z'
    })
    expect(calls[0].sql).toContain("VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
    expect(calls[0].args).toEqual(['s1', 'bh1', 'n1', 'cv1', '/usage', 'silent', '2026-01-01T00:10:00.000Z', expect.any(String)])
    expect(row.status).toBe('pending')
  })

  it('redirectPath 생략 시 NULL 바인딩(빈 문자열이 아니다)', async () => {
    const { db, calls } = makeDb()
    await insert(db, { state: 's1', bindingHash: 'bh1', nonce: 'n1', codeVerifier: 'cv1', mode: 'interactive', expiresAt: 'x' })
    expect(calls[0].args[4]).toBeNull()
  })
})

// (f) state 만료 거부 — claim()이 SQL WHERE 절에 expires_at > ? 조건을 실제로 포함하는지, 그리고
// D1이 changes=0을 돌려줄 때(만료·재사용 어느 쪽이든) boolean false로 정확히 매핑되는지 검증한다.
describe('claim — /callback 검증순서 5(1회성 강제, 결정6)', () => {
  it('SQL이 status=pending AND expires_at > ? 조건부 UPDATE다(만료 강제가 SQL 레이어에 있음을 실측)', async () => {
    const { db, calls } = makeDb({ runResult: { meta: { changes: 1 } } })
    const result = await claim(db, 'state-1')
    expect(calls[0].sql).toContain("status='authorized'")
    expect(calls[0].sql).toContain("status='pending'")
    expect(calls[0].sql).toContain('expires_at > ?')
    expect(calls[0].args[0]).toBe('state-1')
    expect(result).toBe(true)
  })

  // (e) state 1회성 — changes=0(재사용/레이스/만료 전부 이 형태로 수렴)이면 false.
  it('changes===0이면 false를 반환한다(재사용/레이스/만료 전부 이 경로로 수렴)', async () => {
    const { db } = makeDb({ runResult: { meta: { changes: 0 } } })
    const result = await claim(db, 'state-1')
    expect(result).toBe(false)
  })
})

describe('markFailedIfPending — claim() 이전 실패만 전이(M2 처방)', () => {
  it("SQL이 status='pending' 단일 조건이다(authorized 행은 절대 매칭하지 않는다)", async () => {
    const { db, calls } = makeDb()
    const ok = await markFailedIfPending(db, 'state-1')
    expect(calls[0].sql).toContain("status='failed'")
    expect(calls[0].sql).toContain("status='pending'")
    expect(calls[0].sql).not.toContain('authorized')
    expect(ok).toBe(true)
  })

  it('changes===0(이미 다른 요청이 claim()해 authorized로 전이된 행)이면 false', async () => {
    const { db } = makeDb({ runResult: { meta: { changes: 0 } } })
    expect(await markFailedIfPending(db, 'state-1')).toBe(false)
  })
})

describe('markFailedOwned — claim() 이후(이 요청이 소유한 authorized 행) 실패 전이', () => {
  it("SQL이 status='authorized' 조건이다", async () => {
    const { db, calls } = makeDb()
    await markFailedOwned(db, 'state-1')
    expect(calls[0].sql).toContain("status='failed'")
    expect(calls[0].sql).toContain("status='authorized'")
  })
})

// M2 회귀 잠금(완료판정 필수) — security의 repro-markfailed-stomp.mjs 시나리오를 node:sqlite 실제
// DDL 위에서 그대로 재현한다. 이 테스트는 markFailedIfPending이 markFailed(WHERE status IN
// ('pending','authorized'))로 되돌아가면 즉시 실패한다 — B의 pre-claim 실패가 A의 authorized 행을
// 덮어써 A의 setHandoff가 changes=0으로 실패하기 때문이다.
describe('M2 회귀 잠금 — pre-claim 실패가 다른 요청이 소유한 authorized 행을 덮어쓰지 않는다(node:sqlite 실제 DDL)', () => {
  it('A가 claim()해 authorized인 동안 B의 pre-claim 실패(markFailedIfPending)는 A의 로그인을 방해하지 않는다', async () => {
    const db = makeSqliteDb()
    const expiresAt = new Date(Date.now() + 600_000).toISOString()
    await insert(db, { state: 'shared-state', bindingHash: 'bh', nonce: 'n', codeVerifier: 'cv', mode: 'interactive', expiresAt })

    // A: 정상 사용자가 claim()으로 소유권 획득.
    expect(await claim(db, 'shared-state')).toBe(true)
    expect((await findByState(db, 'shared-state')).status).toBe('authorized')

    // B: 쿠키 없는(또는 error 파라미터가 실린) 두 번째 콜백 — claim() 이전 실패 경로이므로
    // markFailedIfPending만 호출해야 하고, 이미 'authorized'인 A의 행은 매칭 조건(status='pending')에
    // 걸리지 않아야 한다.
    const bOwned = await markFailedIfPending(db, 'shared-state')
    expect(bOwned).toBe(false) // B는 그 행의 소유자가 아니었다는 뜻

    // A의 행은 여전히 authorized여야 한다 — B가 덮어썼다면 여기서 'failed'가 된다.
    expect((await findByState(db, 'shared-state')).status).toBe('authorized')

    // A는 핸드오프 발급까지 정상적으로 이어갈 수 있다(=로그인 성공). B의 개입으로 'failed'가
    // 됐다면 이 UPDATE의 WHERE status='authorized'가 매칭되지 않아 changes=0(false)이 된다.
    const handoffSet = await setHandoff(db, 'shared-state', {
      userId: 'user-1', handoffCodeHash: 'hh', handoffExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })
    expect(handoffSet).toBe(true)
  })
})

describe('setHandoff — /callback 검증순서 10', () => {
  it("authorized 상태에만 쓰고, changes로 성패를 반환한다", async () => {
    const { db, calls } = makeDb({ runResult: { meta: { changes: 1 } } })
    const ok = await setHandoff(db, 'state-1', { userId: 'u1', handoffCodeHash: 'hh1', handoffExpiresAt: 'exp' })
    expect(calls[0].sql).toContain("WHERE state=? AND status='authorized'")
    expect(calls[0].args).toEqual(['u1', 'hh1', 'exp', 'state-1'])
    expect(ok).toBe(true)
  })
})

describe('consumeHandoff — /exchange 단독 소비(핸드오프 재사용/만료 방지)', () => {
  it('SQL이 status=authorized AND handoff_expires_at > ? 조건부 UPDATE다', async () => {
    const { db, calls } = makeDb({ runResult: { meta: { changes: 1 } } })
    const ok = await consumeHandoff(db, 'hash-1')
    expect(calls[0].sql).toContain("status='consumed'")
    expect(calls[0].sql).toContain("status='authorized'")
    expect(calls[0].sql).toContain('handoff_expires_at > ?')
    expect(ok).toBe(true)
  })

  it('changes===0(재사용/만료)이면 false', async () => {
    const { db } = makeDb({ runResult: { meta: { changes: 0 } } })
    expect(await consumeHandoff(db, 'hash-1')).toBe(false)
  })
})

describe('findByState / findByHandoffHash — 단순 조회', () => {
  it('state로 단건 조회', async () => {
    const { db, calls } = makeDb({ firstResult: { state: 's1' } })
    const row = await findByState(db, 's1')
    expect(calls[0].sql).toContain('WHERE state = ?')
    expect(row).toEqual({ state: 's1' })
  })

  it('handoff_code_hash로 단건 조회', async () => {
    const { db, calls } = makeDb({ firstResult: { state: 's1' } })
    await findByHandoffHash(db, 'hash-1')
    expect(calls[0].sql).toContain('WHERE handoff_code_hash = ?')
  })
})

describe('deleteExpiredBefore — 크론 스윕(6.9, 보안점검 H1 처방 — 상한 있는 반복 삭제)', () => {
  it('cutoff 이전 만료행을 LIMIT 있는 서브쿼리로 배치 삭제하고 총 삭제 건수를 반환한다', async () => {
    const { db, calls } = makeDb({ runResult: { meta: { changes: 3 } } })
    const total = await deleteExpiredBefore(db, '2026-01-01T00:00:00.000Z', { batchSize: 5000 })
    expect(calls[0].sql).toContain('DELETE FROM google_login_flows WHERE state IN')
    expect(calls[0].sql).toContain('LIMIT ?')
    expect(calls[0].args).toEqual(['2026-01-01T00:00:00.000Z', 5000])
    expect(total).toBe(3)
    expect(calls.length).toBe(1) // 배치가 batchSize보다 적게 지웠으므로 더 돌지 않는다
  })

  it('배치가 batchSize만큼 꽉 차면 계속 반복하고, maxBatches 상한에서 멈춘다(무한 성장 방지)', async () => {
    const { db, calls } = makeDb({ runResult: { meta: { changes: 2 } } }) // batchSize=2로 항상 꽉 참
    const total = await deleteExpiredBefore(db, 'cutoff', { batchSize: 2, maxBatches: 3 })
    expect(calls.length).toBe(3)
    expect(total).toBe(6)
  })

  it('실제 SQLite로 만료행만 지우고 유효행은 남긴다(node:sqlite)', async () => {
    const db = makeSqliteDb()
    const past = new Date(Date.now() - 1000).toISOString()
    const future = new Date(Date.now() + 600_000).toISOString()
    await insert(db, { state: 'expired-1', bindingHash: 'b', nonce: 'n', codeVerifier: 'c', mode: 'interactive', expiresAt: past })
    await insert(db, { state: 'expired-2', bindingHash: 'b', nonce: 'n', codeVerifier: 'c', mode: 'interactive', expiresAt: past })
    await insert(db, { state: 'alive-1', bindingHash: 'b', nonce: 'n', codeVerifier: 'c', mode: 'interactive', expiresAt: future })

    const total = await deleteExpiredBefore(db, new Date().toISOString())
    expect(total).toBe(2)
    expect(await findByState(db, 'expired-1')).toBeNull()
    expect(await findByState(db, 'alive-1')).not.toBeNull()
  })
})
