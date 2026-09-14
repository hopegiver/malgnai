// wbs_items 'cancelled' 상태 회귀/신규 검증 (설계: docs/design/wbs-cancelled-status.md §8 최소 검증 항목).
// buildWbsTree/flattenDepthFirst는 순수함수라 D1 없이 직접 검증한다(server/lib/wbs.js:38,67).
// wbsList의 필터/summary/버킷/description 노출은 db.prepare().bind().all() 형태를 흉내내는
// 가벼운 fake db로 검증한다(이 저장소에 이 패턴의 기존 vitest mock 선례는 없어 새로 구성).
//
// 가드(STATUS_CANCELLED_LEAF_ONLY/PARENT_CANCELLED)는 DB 왕복(SELECT COUNT / SELECT 부모행)이
// 필요해 이 fake db로는 재현이 번거로워 이번 파일에서 생략한다(qa 보고에 명시).
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildWbsTree, flattenDepthFirst, wbsList, wbsAdd, wbsBulkAdd, wbsUpdate } from './wbs.js'

function mkRow(id, parentId, status, progress, opts = {}) {
  const createdAt = opts.createdAt ?? `2026-01-01T00:${String(opts.seq ?? 0).padStart(2, '0')}:00.000Z`
  return {
    id,
    parent_id: parentId,
    depth: opts.depth ?? 0,
    seq: opts.seq ?? 0,
    title: opts.title ?? id,
    description: opts.description ?? null,
    status,
    responsible_team: null,
    assignee_agent_name: null,
    start_date: null,
    end_date: opts.endDate ?? null,
    completed_date: null,
    progress,
    session_id: null,
    idempotency_key: null,
    created_at: createdAt,
    updated_at: createdAt,
    project_id: 'proj-1',
    user_id: 'user-1'
  }
}

function findById(nodes, id) {
  return flattenDepthFirst(nodes).find((n) => n.id === id)
}

// ---------------------------------------------------------------------------
// 1. 무회귀: cancelled 행이 0건일 때 롤업 결과가 기존과 완전히 동일
// ---------------------------------------------------------------------------
describe('rollup — 무회귀 (cancelled 없음, 설계 §8-1)', () => {
  it('done 6 + planned 8 → 43%, in_progress (기존 단순평균과 동일, 설계 §1.1 예시)', () => {
    const rows = [mkRow('root', null, 'planned', 0)]
    for (let i = 0; i < 6; i++) rows.push(mkRow(`done${i}`, 'root', 'done', 100, { seq: i }))
    for (let i = 0; i < 8; i++) rows.push(mkRow(`planned${i}`, 'root', 'planned', 0, { seq: 6 + i }))
    const root = findById(buildWbsTree(rows), 'root')
    expect(root.computedProgress).toBe(43) // (6*100+8*0)/14 = 42.857 → round 43
    expect(root.computedStatus).toBe('in_progress')
  })
})

// ---------------------------------------------------------------------------
// 2. 일부만 취소: 분자·분모 양쪽에서 cancelled 제외
// ---------------------------------------------------------------------------
describe('rollup — 일부만 취소 (설계 §8-2)', () => {
  it('8개 중 2개 cancelled → 나머지 6개만으로 평균 50% (cancelled 포함시 51%와 달라야 함)', () => {
    const rows = [
      mkRow('g2', null, 'planned', 0),
      mkRow('c1', 'g2', 'cancelled', 20, { seq: 0 }),
      mkRow('c2', 'g2', 'cancelled', 90, { seq: 1 }),
      mkRow('d1', 'g2', 'done', 100, { seq: 2 }),
      mkRow('d2', 'g2', 'done', 100, { seq: 3 }),
      mkRow('d3', 'g2', 'done', 100, { seq: 4 }),
      mkRow('p1', 'g2', 'planned', 0, { seq: 5 }),
      mkRow('p2', 'g2', 'planned', 0, { seq: 6 }),
      mkRow('p3', 'g2', 'planned', 0, { seq: 7 })
    ]
    const g2 = findById(buildWbsTree(rows), 'g2')
    // (100*3 + 0*3) / 6 = 50. 만약 cancelled를 분모에 포함했다면 (300+20+90)/8 = 51.25→51 이 된다.
    expect(g2.computedProgress).toBe(50)
    expect(g2.computedStatus).toBe('in_progress')
  })
})

// ---------------------------------------------------------------------------
// 3. 전부 취소(엣지케이스 A)
// ---------------------------------------------------------------------------
describe('rollup — 전부 취소 (엣지케이스 A, 설계 §3.2-A / §8-3)', () => {
  it('자식 전부 cancelled → 그룹 computedStatus=cancelled, computedProgress=0', () => {
    const rows = [mkRow('g3', null, 'planned', 0)]
    ;[10, 20, 30, 40].forEach((p, i) => rows.push(mkRow(`gc${i}`, 'g3', 'cancelled', p, { seq: i })))
    const g3 = findById(buildWbsTree(rows), 'g3')
    expect(g3.computedStatus).toBe('cancelled')
    expect(g3.computedProgress).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. 취소 전파와 부모 제외 (3단 트리)
// ---------------------------------------------------------------------------
describe('rollup — 취소 전파와 부모 제외 (3단 트리, 설계 §8-4)', () => {
  it('전부취소 그룹(3의 g3 상당)은 상위 부모의 분자·분모에서도 자동 제외된다', () => {
    const rows = [
      mkRow('r4', null, 'planned', 0),
      mkRow('g3b', 'r4', 'planned', 0, { seq: 0 }),
      mkRow('leafB', 'r4', 'done', 100, { seq: 1 })
    ]
    ;[10, 20, 30, 40].forEach((p, i) => rows.push(mkRow(`g3bc${i}`, 'g3b', 'cancelled', p, { seq: i })))
    const tree = buildWbsTree(rows)
    const g3b = findById(tree, 'g3b')
    const r4 = findById(tree, 'r4')
    expect(g3b.computedStatus).toBe('cancelled')
    expect(r4.computedProgress).toBe(100) // g3b 제외, leafB(100)만 반영 — (0+100)/2=50이 아니다
    expect(r4.computedStatus).toBe('done')
  })

  it('최상위까지 전부 취소면 루트도 cancelled로 전파된다', () => {
    const rows = [mkRow('rAll', null, 'planned', 0), mkRow('g3c', 'rAll', 'planned', 0, { seq: 0 })]
    ;[5, 15].forEach((p, i) => rows.push(mkRow(`g3cc${i}`, 'g3c', 'cancelled', p, { seq: i })))
    const rAll = findById(buildWbsTree(rows), 'rAll')
    expect(rAll.computedStatus).toBe('cancelled')
    expect(rAll.computedProgress).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. done N + cancelled 1
// ---------------------------------------------------------------------------
describe('rollup — done N + cancelled 1 (설계 §3.2-B / §8-2b)', () => {
  it('done 3 + cancelled 1 → 그룹 done, progress 100', () => {
    const rows = [
      mkRow('g5', null, 'planned', 0),
      mkRow('d1', 'g5', 'done', 100, { seq: 0 }),
      mkRow('d2', 'g5', 'done', 100, { seq: 1 }),
      mkRow('d3', 'g5', 'done', 100, { seq: 2 }),
      mkRow('c1', 'g5', 'cancelled', 0, { seq: 3 })
    ]
    const g5 = findById(buildWbsTree(rows), 'g5')
    expect(g5.computedStatus).toBe('done')
    expect(g5.computedProgress).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 7. 취소 리프의 잔여 progress 보존
// ---------------------------------------------------------------------------
describe('rollup — 취소 리프의 잔여 progress 보존 (설계 §3.2-C / §8-7)', () => {
  it('취소된 리프의 자기 progress(40)는 그대로 남고 상위 평균에는 새어나가지 않는다', () => {
    const rows = [
      mkRow('g7', null, 'planned', 0),
      mkRow('leafC', 'g7', 'cancelled', 40, { seq: 0 }),
      mkRow('leafD', 'g7', 'done', 100, { seq: 1 })
    ]
    const tree = buildWbsTree(rows)
    const leafC = findById(tree, 'leafC')
    const g7 = findById(tree, 'g7')
    expect(leafC.computedProgress).toBe(40)
    expect(leafC.computedStatus).toBe('cancelled')
    expect(g7.computedProgress).toBe(100) // (40+100)/2=70이 아니라 leafD(100)만 반영
  })
})

// ---------------------------------------------------------------------------
// 6/8/9. wbsList — 버킷(D-1)/필터/summary/description 노출
// db.prepare(sql).bind(...).all() 형태를 흉내내는 가벼운 fake db (sql/bind 인자는 무시하고
// 고정된 rows를 반환 — wbsList는 이 쿼리 패턴 한 번만 호출한다, server/lib/wbs.js:96-98)
// ---------------------------------------------------------------------------
function makeFakeDb(rows) {
  return {
    prepare() {
      return {
        bind() {
          return { all: async () => ({ results: rows }) }
        }
      }
    }
  }
}

describe('wbsList — 버킷/필터/summary/description (설계 §3.3, §4, §5.1 / §8-6,8,9)', () => {
  const rows = [
    mkRow('p1', null, 'planned', 0, { seq: 0 }),
    mkRow('ip1', null, 'in_progress', 50, { seq: 1, description: '진행중 메모' }),
    mkRow('d1', null, 'done', 100, { seq: 2 }),
    mkRow('c1', null, 'cancelled', 30, { seq: 3, description: '취소 사유: 전환 결정' }),
    mkRow('c2', null, 'cancelled', 0, { seq: 4, endDate: '2020-01-01' }), // 과거 end_date + cancelled
    mkRow('dl1', null, 'planned', 0, { seq: 5, endDate: '2020-01-01' }) // 진짜 delayed 대조군
  ]
  const db = makeFakeDb(rows)

  it('(6, D-1) end_date가 과거인 cancelled 항목의 bucket은 delayed가 아니라 cancelled', async () => {
    const { items } = await wbsList(db, 'proj-1', { status: 'cancelled' })
    expect(items.map((i) => i.id).sort()).toEqual(['c1', 'c2'])
    expect(items.find((i) => i.id === 'c2').bucket).toBe('cancelled')
  })

  it('(8) 기본 조회는 cancelled를 숨긴다', async () => {
    const { items } = await wbsList(db, 'proj-1', {})
    expect(items.map((i) => i.id).sort()).toEqual(['dl1', 'ip1', 'p1'])
  })

  it('(8) status="cancelled" 명시 조회는 cancelled 항목을 반환한다', async () => {
    const { items } = await wbsList(db, 'proj-1', { status: 'cancelled' })
    expect(items.length).toBe(2)
  })

  it('(8) includeDone:true는 done만 포함시키고 cancelled는 별도 파라미터가 필요하다(의미 분리 — 구코드는 cancelled 행 자체가 없었으므로 이 fixture(6건)에 대해 구코드라면 6건을 반환했을 것이다. "하위호환 불변" 자체는 아래 별도 fixture로 증명한다)', async () => {
    const { items } = await wbsList(db, 'proj-1', { includeDone: true })
    expect(items.map((i) => i.id).sort()).toEqual(['d1', 'dl1', 'ip1', 'p1'])
  })

  it('(8) summary.cancelled 카운트 정확 + summary.total은 취소 포함 전체 수 유지', async () => {
    const { summary } = await wbsList(db, 'proj-1', {})
    expect(summary.total).toBe(6)
    expect(summary.planned).toBe(1)
    expect(summary.inProgress).toBe(1)
    expect(summary.done).toBe(1)
    expect(summary.delayed).toBe(1)
    expect(summary.cancelled).toBe(2)
  })

  it('(9) cancelled 항목만 description이 실리고, cancelled가 아닌 항목엔 실리지 않는다(설계 §5.1)', async () => {
    const { items: cancelledItems } = await wbsList(db, 'proj-1', { status: 'cancelled' })
    expect(cancelledItems.find((i) => i.id === 'c1').description).toBe('취소 사유: 전환 결정')
    expect(cancelledItems.find((i) => i.id === 'c2').description).toBeUndefined() // description 원본이 없던 항목

    const { items: defaultItems } = await wbsList(db, 'proj-1', {})
    const ip1 = defaultItems.find((i) => i.id === 'ip1')
    expect('description' in ip1).toBe(false) // description을 갖고 있지만 cancelled가 아니므로 키 자체가 없어야 함
  })
})

// ---------------------------------------------------------------------------
// 진짜 하위호환 회귀 (reviewer M-5) — cancelled 행이 0건인 fixture로, includeCancelled
// 파라미터의 유무가 결과에 전혀 영향을 주지 않음을 증명한다. 바로 위 describe의 케이스는
// (fixture에 cancelled 2건이 섞여 있어) "신코드 동작 고정"일 뿐 "구코드 대비 불변"의 증거가
// 아니다 — 그 증거는 cancelled 개념 자체가 없던 상황(0건)을 재현해야 성립한다(설계 §8-1).
// ---------------------------------------------------------------------------
describe('wbsList — 진짜 하위호환 회귀 (cancelled 0건 fixture, 설계 §8-1 / reviewer M-5)', () => {
  const noCancelledRows = [
    mkRow('bp1', null, 'planned', 0, { seq: 0 }),
    mkRow('bip1', null, 'in_progress', 50, { seq: 1 }),
    mkRow('bd1', null, 'done', 100, { seq: 2 }),
    mkRow('bdl1', null, 'planned', 0, { seq: 3, endDate: '2020-01-01' })
  ]
  const db2 = makeFakeDb(noCancelledRows)

  it('cancelled 행이 0건이면 includeCancelled 유무와 무관하게 결과가 완전히 동일하다(진짜 불변)', async () => {
    const { items: withoutFlag } = await wbsList(db2, 'proj-1', { includeDone: true })
    const { items: withFlag } = await wbsList(db2, 'proj-1', { includeDone: true, includeCancelled: true })
    expect(withoutFlag.map((i) => i.id).sort()).toEqual(['bd1', 'bdl1', 'bip1', 'bp1'])
    expect(withFlag.map((i) => i.id).sort()).toEqual(withoutFlag.map((i) => i.id).sort())
  })
})

// ===========================================================================
// 실 DDL 하니스 (reviewer H-2) — 이 저장소의 선례(server/api/plugin-deploys.test.js:11,23,
// 35-45, server/dao/google-login-flows.test.js, server/lib/rotating-token.test.js,
// server/api/auth-google.test.js)와 동일 패턴: node:sqlite에 실제 migrations DDL을 올리고
// D1의 prepare().bind().run()/.first()/.all() 인터페이스를 얇은 어댑터로 흉내낸다.
//
// 주의(리뷰어가 실측한 함정): migrations/0001_init_v1_schema.sql 전체를 split(';')로 올리면
// FTS5 트리거(decisions/issues/works 전용) 내부의 ';' 때문에 파싱이 깨진다. wbs_items는 그
// 트리거들과 무관한 섹션이므로, "CREATE TABLE wbs_items"부터 "-- FTS5" 섹션 직전까지의
// 블록만 잘라 올린다.
// ===========================================================================
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

function execSqlBlock(raw, sql) {
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    raw.exec(stmt)
  }
}

/** 0001의 wbs_items 테이블+인덱스 정의만 추출("cancelled" 도입 이전 원본 스키마). */
function extractWbsItemsBlockFrom0001() {
  const full = readFileSync(MIGRATIONS_DIR + '0001_init_v1_schema.sql', 'utf8')
  const start = full.indexOf('CREATE TABLE wbs_items (')
  const end = full.indexOf('-- FTS5', start)
  if (start < 0 || end < 0) {
    throw new Error('0001의 wbs_items/FTS5 마커를 찾지 못했다 — 마이그레이션 파일이 바뀌었는지 확인할 것')
  }
  return full.slice(start, end)
}

function read0029() {
  return readFileSync(MIGRATIONS_DIR + '0029_wbs_items_cancelled_status.sql', 'utf8')
}

/** D1 어댑터 위 실 SQLite. skip0029:true면 "cancelled 도입 이전" 스키마 그대로 반환한다
 *  (마이그레이션 자체를 검증하는 테스트 전용 — 그 외 전부는 0029까지 적용된 상태로 쓴다). */
function makeSqliteDb({ skip0029 = false } = {}) {
  const raw = new DatabaseSync(':memory:')
  execSqlBlock(raw, extractWbsItemsBlockFrom0001())
  if (!skip0029) execSqlBlock(raw, read0029())
  return {
    prepare(sql) {
      return {
        bind: (...args) => ({
          sql,
          args,
          run: async () => {
            const info = raw.prepare(sql).run(...args)
            return { meta: { changes: info.changes } }
          },
          first: async () => raw.prepare(sql).get(...args) || null,
          all: async () => ({ results: raw.prepare(sql).all(...args) })
        })
      }
    },
    // wbsBulkAdd는 db.prepare(...).bind(...)로 만든(=.run()을 호출하지 않은) 문 배열을
    // db.batch()에 넘겨 원자적으로 실행한다(server/lib/wbs.js:280) — plugin-deploys 패턴에는
    // 없던 조합이라 이 파일에서 추가했다.
    batch: async (stmts) => {
      raw.exec('BEGIN')
      try {
        for (const s of stmts) raw.prepare(s.sql).run(...s.args)
        raw.exec('COMMIT')
      } catch (e) {
        raw.exec('ROLLBACK')
        throw e
      }
    },
    _raw: raw
  }
}

let idemSeq = 0
function idemKey() {
  idemSeq += 1
  return `dev1:sess1:${1700000000 + idemSeq}:wbs_item`
}

describe('가드 — PARENT_CANCELLED (실 DDL, reviewer H-2)', () => {
  it('wbsAdd: 저장된 status=cancelled인 부모 아래에 자식 추가 시도 → PARENT_CANCELLED', async () => {
    const db = makeSqliteDb()
    const parent = await wbsAdd(db, { userId: 'u1', projectId: 'proj-1', title: '취소될 부모', idempotencyKey: idemKey() })
    await wbsUpdate(db, { projectId: 'proj-1', id: parent.id, status: 'cancelled' })
    await expect(
      wbsAdd(db, { userId: 'u1', projectId: 'proj-1', parentId: parent.id, title: '자식', idempotencyKey: idemKey() })
    ).rejects.toMatchObject({ code: 'PARENT_CANCELLED' })
  })

  it('wbsBulkAdd: 기존 DB에 저장된 status=cancelled 부모의 parentId를 가리키면 → PARENT_CANCELLED(배치 전체 거부)', async () => {
    const db = makeSqliteDb()
    const parent = await wbsAdd(db, { userId: 'u1', projectId: 'proj-1', title: '취소될 부모', idempotencyKey: idemKey() })
    await wbsUpdate(db, { projectId: 'proj-1', id: parent.id, status: 'cancelled' })
    await expect(
      wbsBulkAdd(db, { userId: 'u1', projectId: 'proj-1', items: [{ tempId: 't1', parentId: parent.id, title: '자식' }] })
    ).rejects.toMatchObject({ code: 'PARENT_CANCELLED' })

    // 거부됐으므로 batch가 실행되지 않아 자식 행이 실제로 생기지 않았는지까지 확인(응답만이
    // 아니라 저장소 상태로 검증).
    const { results } = await db.prepare('SELECT * FROM wbs_items WHERE parent_id = ?').bind(parent.id).all()
    expect(results).toHaveLength(0)
  })
})

describe('가드 — STATUS_CANCELLED_LEAF_ONLY (실 DDL, reviewer H-2)', () => {
  it('wbsUpdate: 자식이 있는 그룹 노드에 status=cancelled를 직접 지정 → STATUS_CANCELLED_LEAF_ONLY', async () => {
    const db = makeSqliteDb()
    const parent = await wbsAdd(db, { userId: 'u1', projectId: 'proj-1', title: '그룹', idempotencyKey: idemKey() })
    await wbsAdd(db, { userId: 'u1', projectId: 'proj-1', parentId: parent.id, title: '자식', idempotencyKey: idemKey() })
    await expect(
      wbsUpdate(db, { projectId: 'proj-1', id: parent.id, status: 'cancelled' })
    ).rejects.toMatchObject({ code: 'STATUS_CANCELLED_LEAF_ONLY' })

    // 거부 후에도 저장값은 그대로(부분 반영 없음).
    const row = await db.prepare('SELECT status FROM wbs_items WHERE id = ?').bind(parent.id).first()
    expect(row.status).not.toBe('cancelled')
  })
})

describe('wbsUpdate 계약 — done→cancelled / progress 비강제 (실 DDL, mcp-tools.md §4.10, reviewer H-2)', () => {
  it('done → cancelled 전이 시 completed_date가 해제된다', async () => {
    const db = makeSqliteDb()
    const leaf = await wbsAdd(db, { userId: 'u1', projectId: 'proj-1', title: '리프', idempotencyKey: idemKey() })
    await wbsUpdate(db, { projectId: 'proj-1', id: leaf.id, status: 'done' })
    const doneRow = await db.prepare('SELECT completed_date FROM wbs_items WHERE id = ?').bind(leaf.id).first()
    expect(doneRow.completed_date).not.toBeNull()

    await wbsUpdate(db, { projectId: 'proj-1', id: leaf.id, status: 'cancelled' })
    const cancelledRow = await db.prepare('SELECT completed_date, status FROM wbs_items WHERE id = ?').bind(leaf.id).first()
    expect(cancelledRow.status).toBe('cancelled')
    expect(cancelledRow.completed_date).toBeNull()
  })

  it('취소 시 progress는 100으로 강제되지 않는다(done과 달리 하던 데까지의 기록을 보존) — 설계 §3.2-C/§5.4', async () => {
    const db = makeSqliteDb()
    const leaf = await wbsAdd(db, { userId: 'u1', projectId: 'proj-1', title: '리프', idempotencyKey: idemKey() })
    await wbsUpdate(db, { projectId: 'proj-1', id: leaf.id, progress: 40 })
    const result = await wbsUpdate(db, { projectId: 'proj-1', id: leaf.id, status: 'cancelled' })
    expect(result.progress).toBe(40) // status='done'이었다면 100으로 강제됐을 값
    const row = await db.prepare('SELECT progress, status FROM wbs_items WHERE id = ?').bind(leaf.id).first()
    expect(row.status).toBe('cancelled')
    expect(row.progress).toBe(40)
  })
})

describe('wbsList — includeCancelled:true 참 분기 (실 DDL, reviewer H-2)', () => {
  it('status 필터 없이 includeCancelled:true를 주면 기본 숨김이 풀려 취소 항목이 포함된다', async () => {
    const db = makeSqliteDb()
    const active = await wbsAdd(db, { userId: 'u1', projectId: 'proj-1', title: '활성', idempotencyKey: idemKey() })
    const toCancel = await wbsAdd(db, { userId: 'u1', projectId: 'proj-1', title: '취소될 항목', idempotencyKey: idemKey() })
    await wbsUpdate(db, { projectId: 'proj-1', id: toCancel.id, status: 'cancelled' })

    const { items: withoutFlag } = await wbsList(db, 'proj-1', {})
    expect(withoutFlag.map((i) => i.id).sort()).toEqual([active.id])

    const { items: withFlag } = await wbsList(db, 'proj-1', { includeCancelled: true })
    expect(withFlag.map((i) => i.id).sort()).toEqual([active.id, toCancel.id].sort())
    expect(withFlag.find((i) => i.id === toCancel.id).bucket).toBe('cancelled')
  })
})

describe('마이그레이션 0029 — 실 DDL 적용 (reviewer H-2)', () => {
  const COLUMNS = '(id, project_id, user_id, parent_id, depth, seq, title, description, status, responsible_team, assignee_agent_name, start_date, end_date, completed_date, progress, session_id, idempotency_key, created_at, updated_at)'
  const PLACEHOLDERS = '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'

  function insertPreMigrationRow(raw, { id, status, progress, description = null }) {
    const now = '2026-01-01T00:00:00.000Z'
    raw.prepare(`INSERT INTO wbs_items ${COLUMNS} VALUES ${PLACEHOLDERS}`).run(
      id, 'proj-1', 'user-1', null, 0, 0, `title-${id}`, description, status,
      null, null, null, null, null, progress, null, `idem-${id}`, now, now
    )
  }

  it('적용 전후 행 수·값 보존(ⓐ) + 인덱스 3종 재존재(ⓑ) + CHECK가 cancelled 수용·엉뚱값 거부(ⓒ)', () => {
    const raw = new DatabaseSync(':memory:')
    execSqlBlock(raw, extractWbsItemsBlockFrom0001())

    insertPreMigrationRow(raw, { id: 'w1', status: 'planned', progress: 0, description: '메모1' })
    insertPreMigrationRow(raw, { id: 'w2', status: 'done', progress: 100 })

    const beforeCount = raw.prepare('SELECT COUNT(*) AS c FROM wbs_items').get().c
    expect(beforeCount).toBe(2)

    // ---- 0029 적용 ----
    execSqlBlock(raw, read0029())

    // ⓐ 행 수·값 보존
    const afterCount = raw.prepare('SELECT COUNT(*) AS c FROM wbs_items').get().c
    expect(afterCount).toBe(2)
    const w1 = raw.prepare('SELECT * FROM wbs_items WHERE id = ?').get('w1')
    expect(w1.title).toBe('title-w1')
    expect(w1.description).toBe('메모1')
    expect(w1.status).toBe('planned')
    expect(w1.idempotency_key).toBe('idem-w1')
    const w2 = raw.prepare('SELECT * FROM wbs_items WHERE id = ?').get('w2')
    expect(w2.status).toBe('done')
    expect(w2.progress).toBe(100)

    // ⓑ 인덱스 3종 재존재 (PRIMARY KEY/idempotency_key UNIQUE가 만드는 sqlite_autoindex_*는
    // 0009/0018/0021과 같은 재생성 패턴에서 항상 같이 따라오는 부산물이라 제외하고 본다 —
    // 이 테스트가 잠그려는 것은 명시적으로 CREATE INDEX한 3개다)
    const idxNames = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='wbs_items'")
      .all().map((r) => r.name).filter((n) => !n.startsWith('sqlite_autoindex_')).sort()
    expect(idxNames).toEqual(['idx_wbs_items_project', 'idx_wbs_items_project_status', 'idx_wbs_items_session'])

    // ⓒ CHECK가 cancelled를 수용
    insertPreMigrationRow(raw, { id: 'w3', status: 'cancelled', progress: 0 })
    const w3 = raw.prepare('SELECT status FROM wbs_items WHERE id = ?').get('w3')
    expect(w3.status).toBe('cancelled')

    // ⓒ CHECK가 엉뚱한 값을 거부
    expect(() => insertPreMigrationRow(raw, { id: 'w4', status: 'bogus_status', progress: 0 })).toThrow()
  })

  it('0029 적용 전(구 스키마)에는 status=cancelled INSERT 자체가 CHECK 위반으로 거부된다(대조군)', () => {
    const raw = new DatabaseSync(':memory:')
    execSqlBlock(raw, extractWbsItemsBlockFrom0001())
    expect(() => insertPreMigrationRow(raw, { id: 'pre1', status: 'cancelled', progress: 0 })).toThrow()
  })
})
