// rotateOrDetectReuse() 단위테스트 — 이 파일이 오탐 완화 변경의 증명이다
// (docs/design/oauth-refresh-race-mitigation.md §11.2). 인메모리 fake DAO로 findByHash/markRotated/
// revokeAll의 실제 SQL 부작용(revokeAll이 "가족" 전체의 revoke_reason·revoked_at을 덮어쓰는 것,
// server/dao/*-tokens.js의 `WHERE ... != 'revoked'`)을 그대로 흉내 내어, "연쇄 확정" 버그가
// 재현되는지/고쳐졌는지를 직접 검증한다. 시간 제어는 §11.1 지침대로 vi.useFakeTimers +
// vi.setSystemTime만 쓴다(함수 시그니처에 clock을 추가하지 않는다).
//
// [reviewer 리뷰 M1] 아래 fake DAO는 실재하지 않는 `family_id` 컬럼으로 가족을 묶고, 이 파일의
// 케이스가 전부 store 행 1개짜리라 "stale 하나가 형제 리프 다수를 동반 폐기하는" 이번 버그의
// 실제 피해(설계 §2.1 — 활성 리프 최대 15개 동시 사망)를 검증하지 못했다. 실물은
// `WHERE device_token_id = ?`(MCP, server/dao/oauth-refresh-tokens.js)·`WHERE user_id = ?`
// (웹, server/dao/refresh-tokens.js)로 묶는다 — 아래 fake의 그룹 키를 실물 컬럼명
// `device_token_id`로 바로잡았다(웹 축 테스트에서는 같은 필드를 user_id 대용으로 재사용한다는
// 뜻이 아니라, 두 정책을 한 fake로 비교하기 위한 값일 뿐이다 — 실물 컬럼 위에서의 검증은 파일
// 하단 "형제 행 생존/사망 — 실제 DDL" 섹션이 오직 실DAO·실컬럼으로 담당한다).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rotateOrDetectReuse, MCP_OAUTH_REFRESH_POLICY, WEB_REFRESH_POLICY } from './rotating-token.js'
import * as oauthRefreshTokensDao from '../dao/oauth-refresh-tokens.js'
import * as refreshTokensDao from '../dao/refresh-tokens.js'

const DB = {}
const BASE_TIME = new Date('2026-09-15T00:00:00.000Z')

function makeRow(overrides = {}) {
  return {
    id: 'tok-1',
    token_hash: 'hash-1',
    status: 'active',
    revoke_reason: null,
    revoked_at: null,
    expires_at: new Date(BASE_TIME.getTime() + 3600_000).toISOString(),
    device_token_id: 'family-1', // 실물 그룹 키 이름을 그대로 씀(위 M1 설명 참고)
    ...overrides
  }
}

/** 실제 DAO(server/dao/oauth-refresh-tokens.js, server/dao/refresh-tokens.js)의 SQL 부작용을
 *  인메모리로 흉내 낸다 — 특히 revokeAll의 `WHERE device_token_id = ? AND status != 'revoked'`
 *  (MCP 축 실물 SQL 그대로, 웹 축은 컬럼명만 user_id)가 같은 가족의 다른 행까지 덮어쓰는 것
 *  (현재 구조가 연쇄로 확정되는 원인, 설계 §3)을 재현해야 U-9/U-10이 의미가 있다. */
function makeFakeDao(rows) {
  const store = rows.map((r) => ({ ...r }))
  const findByHash = vi.fn(async (db, tokenHash) => store.find((r) => r.token_hash === tokenHash))
  const markRotated = vi.fn(async (db, id) => {
    const row = store.find((r) => r.id === id && r.status === 'active')
    if (!row) return false
    row.status = 'rotated'
    row.revoke_reason = 'rotated'
    row.revoked_at = new Date().toISOString()
    return true
  })
  const revokeAll = vi.fn(async (db, stored, reason) => {
    for (const row of store) {
      if (row.device_token_id === stored.device_token_id && row.status !== 'revoked') {
        row.status = 'revoked'
        row.revoke_reason = reason
        row.revoked_at = new Date().toISOString()
      }
    }
  })
  return { store, dao: { findByHash, markRotated, revokeAll } }
}

const POLICIES = [
  ['mcp', MCP_OAUTH_REFRESH_POLICY],
  ['web', WEB_REFRESH_POLICY]
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)
})

afterEach(() => {
  vi.useRealTimers()
})

describe.each(POLICIES)('U-1 active + 유효 (%s)', (_, policy) => {
  it('ok:true, path:rotated, markRotated 1회, revokeAll 0회', async () => {
    const { dao } = makeFakeDao([makeRow()])
    const result = await rotateOrDetectReuse(DB, 'hash-1', dao, policy)
    expect(result).toMatchObject({ ok: true, path: 'rotated' })
    expect(dao.markRotated).toHaveBeenCalledTimes(1)
    expect(dao.revokeAll).not.toHaveBeenCalled()
  })
})

describe.each(POLICIES)('U-2 active + expires_at 과거 (%s)', (_, policy) => {
  it('invalid/expired, revokeAll 0회', async () => {
    const { dao } = makeFakeDao([makeRow({ expires_at: new Date(BASE_TIME.getTime() - 1000).toISOString() })])
    const result = await rotateOrDetectReuse(DB, 'hash-1', dao, policy)
    expect(result).toEqual({ ok: false, reason: 'invalid', detail: 'expired' })
    expect(dao.markRotated).not.toHaveBeenCalled()
    expect(dao.revokeAll).not.toHaveBeenCalled()
  })
})

describe.each(POLICIES)('U-3 없는 해시 (%s)', (_, policy) => {
  it('invalid/not_found', async () => {
    const { dao } = makeFakeDao([])
    const result = await rotateOrDetectReuse(DB, 'missing-hash', dao, policy)
    expect(result).toEqual({ ok: false, reason: 'invalid', detail: 'not_found' })
  })
})

describe.each(POLICIES)('U-4 rotated, 나이 3초 (%s)', (_, policy) => {
  it('ok:true path:grace, revokeAll 0회', async () => {
    const { dao } = makeFakeDao([makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: BASE_TIME.toISOString() })])
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 3000))
    const result = await rotateOrDetectReuse(DB, 'hash-1', dao, policy)
    expect(result).toMatchObject({ ok: true, path: 'grace', staleAgeMs: 3000, entry: 'stale' })
    expect(dao.revokeAll).not.toHaveBeenCalled()
  })
})

async function runAged(policy, ageMs) {
  const { dao } = makeFakeDao([makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: BASE_TIME.toISOString() })])
  vi.setSystemTime(new Date(BASE_TIME.getTime() + ageMs))
  const result = await rotateOrDetectReuse(DB, 'hash-1', dao, policy)
  return { result, dao }
}

describe('U-5 rotated, 나이 54.4초(실측 버스트2 첫 요청)', () => {
  it('MCP: ok:true path:grace / Web: reuse_detected, revokeAll 1회', async () => {
    const mcp = await runAged(MCP_OAUTH_REFRESH_POLICY, 54_400)
    expect(mcp.result).toMatchObject({ ok: true, path: 'grace' })
    expect(mcp.dao.revokeAll).not.toHaveBeenCalled()

    const web = await runAged(WEB_REFRESH_POLICY, 54_400)
    expect(web.result).toMatchObject({ ok: false, reason: 'reuse_detected' })
    expect(web.dao.revokeAll).toHaveBeenCalledTimes(1)
  })
})

describe('U-6 rotated, 나이 320.2초(실측 최악 오탐)', () => {
  it('MCP: ok:true path:grace / Web: reuse_detected', async () => {
    const mcp = await runAged(MCP_OAUTH_REFRESH_POLICY, 320_200)
    expect(mcp.result).toMatchObject({ ok: true, path: 'grace' })

    const web = await runAged(WEB_REFRESH_POLICY, 320_200)
    expect(web.result).toMatchObject({ ok: false, reason: 'reuse_detected' })
  })
})

describe('U-7 rotated, 나이 600초 정확히(경계)', () => {
  it('MCP: ok:true(<= 비교) / Web: reuse_detected', async () => {
    const mcp = await runAged(MCP_OAUTH_REFRESH_POLICY, 600_000)
    expect(mcp.result).toMatchObject({ ok: true, path: 'grace', staleAgeMs: 600_000 })

    const web = await runAged(WEB_REFRESH_POLICY, 600_000)
    expect(web.result).toMatchObject({ ok: false, reason: 'reuse_detected' })
  })
})

describe('U-8 rotated, 나이 600.001초', () => {
  it('MCP: stale_reuse, revokeAll 0회 / Web: reuse_detected, revokeAll 1회', async () => {
    const mcp = await runAged(MCP_OAUTH_REFRESH_POLICY, 600_001)
    expect(mcp.result).toMatchObject({ ok: false, reason: 'stale_reuse', staleAgeMs: 600_001 })
    expect(mcp.dao.revokeAll).not.toHaveBeenCalled()

    const web = await runAged(WEB_REFRESH_POLICY, 600_001)
    expect(web.result).toMatchObject({ ok: false, reason: 'reuse_detected' })
    expect(web.dao.revokeAll).toHaveBeenCalledTimes(1)
  })
})

describe('U-9 연쇄 차단 회귀 테스트 — 프로덕션 실측 버스트 재현(2026-08-31, 30초에 11회 연속)', () => {
  // 실측: 가족 마지막 정상 회전 20:12:03.311, 첫 오탐 +149.7초, 버스트 지속 30.5초, 11건, 마지막 +180초.
  const t0 = new Date('2026-08-31T20:12:03.311Z')
  const ageSecList = [149.7, 152, 155, 158, 161, 164, 167, 170, 173, 176, 180]

  it('MCP 정책: 11회 전부 ok:true path:grace, revokeAll 0회 — 연쇄 확정이 발생하지 않는다', async () => {
    const { dao } = makeFakeDao([makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: t0.toISOString() })])
    for (const ageSec of ageSecList) {
      vi.setSystemTime(new Date(t0.getTime() + ageSec * 1000))
      const result = await rotateOrDetectReuse(DB, 'hash-1', dao, MCP_OAUTH_REFRESH_POLICY)
      expect(result.ok).toBe(true)
      expect(result.path).toBe('grace')
    }
    expect(dao.revokeAll).not.toHaveBeenCalled()
  })

  it('웹 정책(비교군): 1회차만 reuse_detected(revokeAll 1회), 이후 10회는 already_revoked(재폐기 없음, D4)', async () => {
    const { dao } = makeFakeDao([makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: t0.toISOString() })])
    const results = []
    for (const ageSec of ageSecList) {
      vi.setSystemTime(new Date(t0.getTime() + ageSec * 1000))
      results.push(await rotateOrDetectReuse(DB, 'hash-1', dao, WEB_REFRESH_POLICY))
    }
    expect(results[0]).toMatchObject({ ok: false, reason: 'reuse_detected' })
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toMatchObject({ ok: false, reason: 'already_revoked' })
    }
    expect(dao.revokeAll).toHaveBeenCalledTimes(1) // 재폐기 없음 — 웹 축도 D4는 적용된다
  })
})

describe('U-10 연쇄 차단(임계 밖) — 나이 45분짜리 stale을 1초 간격 5회 호출', () => {
  const t0 = new Date('2026-09-06T02:47:25.389Z')
  const ageSecList = [2700, 2701, 2702, 2703, 2704] // 45분 + 0~4초

  it('MCP 정책: 5회 전부 stale_reuse, revokeAll 0회 — 5회차도 reuse_detected가 아니다', async () => {
    const { dao } = makeFakeDao([makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: t0.toISOString() })])
    for (const ageSec of ageSecList) {
      vi.setSystemTime(new Date(t0.getTime() + ageSec * 1000))
      const result = await rotateOrDetectReuse(DB, 'hash-1', dao, MCP_OAUTH_REFRESH_POLICY)
      expect(result).toMatchObject({ ok: false, reason: 'stale_reuse' })
    }
    expect(dao.revokeAll).not.toHaveBeenCalled()
  })

  it('웹 정책: 1회차 reuse_detected(revokeAll 1회), 이후 already_revoked(revokeAll 총 1회)', async () => {
    const { dao } = makeFakeDao([makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: t0.toISOString() })])
    const results = []
    for (const ageSec of ageSecList) {
      vi.setSystemTime(new Date(t0.getTime() + ageSec * 1000))
      results.push(await rotateOrDetectReuse(DB, 'hash-1', dao, WEB_REFRESH_POLICY))
    }
    expect(results[0]).toMatchObject({ ok: false, reason: 'reuse_detected' })
    for (let i = 1; i < results.length; i++) expect(results[i]).toMatchObject({ ok: false, reason: 'already_revoked' })
    expect(dao.revokeAll).toHaveBeenCalledTimes(1)
  })
})

describe.each(POLICIES)('U-11 revoke_reason=reuse_detected 행 재제시 (%s)', (_, policy) => {
  it('already_revoked, revokeAll 0회(D4 — 현행에서 바뀌는 지점)', async () => {
    const { dao } = makeFakeDao([makeRow({ status: 'revoked', revoke_reason: 'reuse_detected', revoked_at: BASE_TIME.toISOString() })])
    const result = await rotateOrDetectReuse(DB, 'hash-1', dao, policy)
    expect(result).toMatchObject({ ok: false, reason: 'already_revoked' })
    expect(dao.revokeAll).not.toHaveBeenCalled()
  })
})

describe.each(POLICIES)('U-12 revoke_reason=logout 재제시 (%s)', (_, policy) => {
  it('reuse_detected, revokeAll 1회', async () => {
    const { dao } = makeFakeDao([makeRow({ status: 'revoked', revoke_reason: 'logout', revoked_at: BASE_TIME.toISOString() })])
    const result = await rotateOrDetectReuse(DB, 'hash-1', dao, policy)
    expect(result).toMatchObject({ ok: false, reason: 'reuse_detected', trigger: 'explicit_revoke' })
    expect(dao.revokeAll).toHaveBeenCalledTimes(1)
  })
})

describe.each(POLICIES)('U-13 revoke_reason=device_revoked 재제시 (%s)', (_, policy) => {
  it('reuse_detected, revokeAll 1회', async () => {
    const { dao } = makeFakeDao([makeRow({ status: 'revoked', revoke_reason: 'device_revoked', revoked_at: BASE_TIME.toISOString() })])
    const result = await rotateOrDetectReuse(DB, 'hash-1', dao, policy)
    expect(result).toMatchObject({ ok: false, reason: 'reuse_detected', trigger: 'explicit_revoke' })
    expect(dao.revokeAll).toHaveBeenCalledTimes(1)
  })
})

describe('U-14 status=rotated + revoked_at=null(결손)', () => {
  it('MCP: stale_reuse(fail-closed) / Web: reuse_detected', async () => {
    const mcpDao = makeFakeDao([makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: null })])
    const mcpResult = await rotateOrDetectReuse(DB, 'hash-1', mcpDao.dao, MCP_OAUTH_REFRESH_POLICY)
    expect(mcpResult).toMatchObject({ ok: false, reason: 'stale_reuse', staleAgeMs: Number.POSITIVE_INFINITY })
    expect(mcpDao.dao.revokeAll).not.toHaveBeenCalled()

    const webDao = makeFakeDao([makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: null })])
    const webResult = await rotateOrDetectReuse(DB, 'hash-1', webDao.dao, WEB_REFRESH_POLICY)
    expect(webResult).toMatchObject({ ok: false, reason: 'reuse_detected' })
    expect(webDao.dao.revokeAll).toHaveBeenCalledTimes(1)
  })
})

/** U-15/U-16/U-17: 레이스 패배(markRotated가 false) 시나리오. 최초 조회 스냅샷은 아직 active로
 *  보이지만, 그 사이 다른 동시 요청이 이미 회전시켜 실제로는 markRotated가 실패하는 상황을
 *  두 단계 findByHash 응답(mockResolvedValueOnce 2회)으로 재현한다. */
function makeRaceDao({ refetched }) {
  const activeSnapshot = makeRow({ status: 'active' })
  const findByHash = vi.fn()
    .mockResolvedValueOnce(activeSnapshot)
    .mockResolvedValueOnce(refetched)
  const markRotated = vi.fn().mockResolvedValue(false)
  const revokeAll = vi.fn()
  return { findByHash, markRotated, revokeAll }
}

describe.each(POLICIES)('U-15 레이스 패배 + 재조회 나이 2초 (%s)', (_, policy) => {
  it('ok:true, path:grace, entry:race', async () => {
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 2000))
    const dao = makeRaceDao({
      refetched: makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: BASE_TIME.toISOString() })
    })
    const result = await rotateOrDetectReuse(DB, 'hash-1', dao, policy)
    expect(result).toMatchObject({ ok: true, path: 'grace', entry: 'race', staleAgeMs: 2000 })
    expect(dao.revokeAll).not.toHaveBeenCalled()
  })
})

describe('U-16 레이스 패배 + 재조회 나이 5분', () => {
  it('MCP: ok:true path:grace / Web: reuse_detected', async () => {
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 5 * 60_000))
    const refetched = makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: BASE_TIME.toISOString() })

    const mcpDao = makeRaceDao({ refetched })
    const mcpResult = await rotateOrDetectReuse(DB, 'hash-1', mcpDao, MCP_OAUTH_REFRESH_POLICY)
    expect(mcpResult).toMatchObject({ ok: true, path: 'grace', entry: 'race' })

    const webDao = makeRaceDao({ refetched })
    const webResult = await rotateOrDetectReuse(DB, 'hash-1', webDao, WEB_REFRESH_POLICY)
    expect(webResult).toMatchObject({ ok: false, reason: 'reuse_detected' })
  })
})

describe.each(POLICIES)('U-17 레이스 패배 + 재조회가 undefined (%s)', (_, policy) => {
  it('reuse_detected(현행과 동일한 fail-closed), trigger는 refetch_missing(명시적 폐기 아님, reviewer m3)', async () => {
    const dao = makeRaceDao({ refetched: undefined })
    const result = await rotateOrDetectReuse(DB, 'hash-1', dao, policy)
    expect(result).toMatchObject({ ok: false, reason: 'reuse_detected', trigger: 'refetch_missing' })
    expect(dao.revokeAll).toHaveBeenCalledTimes(1)
  })
})

describe('U-18 정책 인자 생략', () => {
  it('WEB_REFRESH_POLICY와 동일 결과(fail-safe default 고정) — 나이 54.4초는 reuse_detected여야 한다', async () => {
    const { dao } = makeFakeDao([makeRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: BASE_TIME.toISOString() })])
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 54_400))
    const result = await rotateOrDetectReuse(DB, 'hash-1', dao) // policy 생략
    expect(result).toMatchObject({ ok: false, reason: 'reuse_detected' })
    expect(dao.revokeAll).toHaveBeenCalledTimes(1)
  })
})

describe('U-19 웹 정책에서 stale_reuse가 절대 반환되지 않는다', () => {
  it.each([100, 5000, 9999, 10001, 54_400, 320_200, 600_000, 600_001, 999_999_999])('나이 %dms', async (ageMs) => {
    const { result } = await runAged(WEB_REFRESH_POLICY, ageMs)
    expect(result.reason).not.toBe('stale_reuse')
  })
})

// ---------------------------------------------------------------------------------------------
// 형제 행 생존/사망 — 실제 DDL(node:sqlite, reviewer 리뷰 M1)
//
// server/dao/google-login-flows.test.js:33-70의 하니스를 그대로 이식한다. fake DAO(위)는
// 존재하지 않는 컬럼을 스스로 정의해 쓰므로, "revokeAll이 실제 스키마의 어느 컬럼으로 몇 개의
// 행을 덮어쓰는지"는 실물 CHECK·컬럼명 위에서만 증명된다. 이 섹션이 이번 변경(D3 reject_only)이
// 고쳤다고 주장하는 바로 그 피해 — stale 하나가 형제 리프 다수를 동반 폐기하는 것(설계 §2.1,
// 프로덕션 실측 최대 15개) — 을 실제 oauth_refresh_tokens/refresh_tokens 테이블 위에서 검증한다.
// ---------------------------------------------------------------------------------------------
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))
// 정본 순서 그대로 적용한다 — refresh_tokens/device_tokens 최초 정의(0001) → refresh_tokens에
// revoke_reason 추가(0002) → oauth_refresh_tokens 최초 정의(0007) → device_tokens에
// oauth_client_id 추가(0008, 이 테스트엔 불필요하지만 실제 배포 순서를 그대로 재현해 "이후
// 마이그레이션과 충돌하지 않는다"까지 함께 확인한다).
const REAL_DDL_MIGRATIONS = [
  '0001_init_v1_schema.sql',
  '0002_add_refresh_token_revoke_reason.sql',
  '0007_oauth_tokens.sql',
  '0008_device_tokens_oauth_client.sql'
]

function makeSqliteDb() {
  const raw = new DatabaseSync(':memory:')
  for (const file of REAL_DDL_MIGRATIONS) {
    const ddl = readFileSync(MIGRATIONS_DIR + file, 'utf8')
    // 0001에는 `CREATE TRIGGER ... BEGIN ... ; ... END;` 복합문(decisions_fts 등)이 있어
    // google-login-flows.test.js처럼 ';'로 단순 분리하면 트리거 본문 중간이 잘린다
    // ("incomplete input"). node:sqlite의 exec()는 한 번에 여러 statement를 받아들이므로
    // 파일 전체를 그대로 넘긴다.
    raw.exec(ddl)
  }
  // D1 prepare().bind(...).run()/.first() 인터페이스를 흉내내는 아주 얇은 어댑터(google-login-flows
  // 테스트와 동일 패턴).
  return {
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
          }
        })
      }
    }
  }
}

// 테스트 셋업 전용 — 각 DAO의 insert()는 status='active' 신규 발급만 지원해, 이미 회전된 부모나
// 과거 타임스탬프를 가진 "형제 리프"를 만들 수 없다. 컬럼은 실제 마이그레이션 그대로다.
async function seedOauthRefreshRow(db, row) {
  await db.prepare(
    `INSERT INTO oauth_refresh_tokens (id, device_token_id, token_hash, status, revoke_reason, expires_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.id, row.device_token_id, row.token_hash, row.status, row.revoke_reason ?? null, row.expires_at, row.created_at, row.revoked_at ?? null).run()
}

async function seedRefreshTokenRow(db, row) {
  await db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, status, revoke_reason, expires_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.id, row.user_id, row.token_hash, row.status, row.revoke_reason ?? null, row.expires_at, row.created_at, row.revoked_at ?? null).run()
}

function farFuture(t0) {
  return new Date(t0.getTime() + 24 * 3600_000).toISOString()
}

describe('형제 행 생존/사망 — 실제 DDL(node:sqlite, reviewer 리뷰 M1)', () => {
  const FAMILY = 'device-family-1'
  const t0 = new Date('2026-09-15T00:00:00.000Z')

  const oauthDao = {
    findByHash: oauthRefreshTokensDao.findByHash,
    markRotated: oauthRefreshTokensDao.markRotated,
    revokeAll: (db, stored, reason) => oauthRefreshTokensDao.revokeAllForDeviceToken(db, stored.device_token_id, reason)
  }

  // 부모(=stale로 재제시될 토큰) 1개 + 형제 리프(각자 grace를 통과해 독립적으로 발급된 active
  // refresh token, 설계 §2.1의 "활성 리프 다수"를 축소 재현) 2개를 같은 device_token_id 가족에 심는다.
  async function seedOauthFamily(db) {
    await seedOauthRefreshRow(db, {
      id: 'parent', device_token_id: FAMILY, token_hash: 'hash-parent',
      status: 'rotated', revoke_reason: 'rotated', expires_at: farFuture(t0),
      created_at: t0.toISOString(), revoked_at: t0.toISOString()
    })
    await seedOauthRefreshRow(db, {
      id: 'sib-1', device_token_id: FAMILY, token_hash: 'hash-sib-1',
      status: 'active', revoke_reason: null, expires_at: farFuture(t0),
      created_at: t0.toISOString(), revoked_at: null
    })
    await seedOauthRefreshRow(db, {
      id: 'sib-2', device_token_id: FAMILY, token_hash: 'hash-sib-2',
      status: 'active', revoke_reason: null, expires_at: farFuture(t0),
      created_at: t0.toISOString(), revoked_at: null
    })
  }

  it('MCP 정책: grace 밖(45분) stale 재제시에도 형제 리프의 status/revoke_reason/revoked_at이 그대로다(reject_only가 연쇄 확정 경로를 끊는다)', async () => {
    const db = makeSqliteDb()
    await seedOauthFamily(db)
    vi.setSystemTime(new Date(t0.getTime() + 45 * 60_000)) // grace(10분) 밖

    const result = await rotateOrDetectReuse(db, 'hash-parent', oauthDao, MCP_OAUTH_REFRESH_POLICY)
    expect(result).toMatchObject({ ok: false, reason: 'stale_reuse' })

    const sib1 = await oauthRefreshTokensDao.findByHash(db, 'hash-sib-1')
    const sib2 = await oauthRefreshTokensDao.findByHash(db, 'hash-sib-2')
    expect(sib1).toMatchObject({ status: 'active', revoke_reason: null, revoked_at: null })
    expect(sib2).toMatchObject({ status: 'active', revoke_reason: null, revoked_at: null })
  })

  it('MCP 정책: 실측 버스트 재현(2026-08-31, 30초에 11회 연속)에서도 형제 리프가 끝까지 생존한다', async () => {
    const db = makeSqliteDb()
    await seedOauthFamily(db)
    const ageSecList = [149.7, 152, 155, 158, 161, 164, 167, 170, 173, 176, 180]

    for (const ageSec of ageSecList) {
      vi.setSystemTime(new Date(t0.getTime() + ageSec * 1000))
      const result = await rotateOrDetectReuse(db, 'hash-parent', oauthDao, MCP_OAUTH_REFRESH_POLICY)
      expect(result.ok).toBe(true)
      expect(result.path).toBe('grace')
    }

    const sib1 = await oauthRefreshTokensDao.findByHash(db, 'hash-sib-1')
    const sib2 = await oauthRefreshTokensDao.findByHash(db, 'hash-sib-2')
    expect(sib1.status).toBe('active')
    expect(sib2.status).toBe('active')
  })

  it('웹 정책(엄격도 비교): 같은 상황에서 grace 밖 stale이 형제 리프까지 폐기한다 — 가족 전체 사망이 그대로 유지된다', async () => {
    const webDb = makeSqliteDb()
    const userId = 'user-1'
    await seedRefreshTokenRow(webDb, {
      id: 'w-parent', user_id: userId, token_hash: 'w-hash-parent',
      status: 'rotated', revoke_reason: 'rotated', expires_at: farFuture(t0),
      created_at: t0.toISOString(), revoked_at: t0.toISOString()
    })
    await seedRefreshTokenRow(webDb, {
      id: 'w-sib-1', user_id: userId, token_hash: 'w-hash-sib-1',
      status: 'active', revoke_reason: null, expires_at: farFuture(t0),
      created_at: t0.toISOString(), revoked_at: null
    })
    await seedRefreshTokenRow(webDb, {
      id: 'w-sib-2', user_id: userId, token_hash: 'w-hash-sib-2',
      status: 'active', revoke_reason: null, expires_at: farFuture(t0),
      created_at: t0.toISOString(), revoked_at: null
    })
    const webDao = {
      findByHash: refreshTokensDao.findByHash,
      markRotated: refreshTokensDao.markRotated,
      revokeAll: (db, stored, reason) => refreshTokensDao.revokeAllForUser(db, stored.user_id, reason)
    }

    vi.setSystemTime(new Date(t0.getTime() + 45 * 60_000)) // 웹 grace(10초) 밖

    const result = await rotateOrDetectReuse(webDb, 'w-hash-parent', webDao, WEB_REFRESH_POLICY)
    expect(result).toMatchObject({ ok: false, reason: 'reuse_detected' })

    const sib1 = await refreshTokensDao.findByHash(webDb, 'w-hash-sib-1')
    const sib2 = await refreshTokensDao.findByHash(webDb, 'w-hash-sib-2')
    expect(sib1).toMatchObject({ status: 'revoked', revoke_reason: 'reuse_detected' })
    expect(sib2).toMatchObject({ status: 'revoked', revoke_reason: 'reuse_detected' })
  })
})
