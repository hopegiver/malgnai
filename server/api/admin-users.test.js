// PUT /api/admin/users/:id/employee-id + POST /api/admin/users(§5.8 기본값) 라우트 레벨 단위테스트.
// docs/design/usage-employee-identity-linking.md 정본 — Sensitive 등급(식별자 재연결 = IDOR과
// 같은 부류의 조작)이라 403/409/원자 커밋/no-op 무기록을 각각 별도로 증명한다.
// server/dao/users.js는 findById/findByEmployeeId/buildUpdateEmployeeIdStatement만 대체,
// server/dao/audit-logs.js는 buildRecordStatementIfPrecedingChanged만 대체해 D1 없이 라우트
// 로직만 검증한다(M-2 수정, 리뷰 2026-09-07 — CAS UPDATE와 짝인 조건부 감사 INSERT).
// c.env.DB.batch()는 이 파일이 직접 제어하는 vi.fn()이다(원자 커밋 여부·인자를 그대로 관찰한다).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const findByIdMock = vi.fn()
const findByEmailMock = vi.fn()
const findByEmployeeIdMock = vi.fn()
const insertMock = vi.fn()
const listAllMock = vi.fn()
const buildUpdateEmployeeIdStatementMock = vi.fn()
const buildRecordStatementIfPrecedingChangedMock = vi.fn()
// 공용 워크스테이션 레지스트리 PK 단건 조회(usage_shared_workstations, migrations/0022) —
// docs/design/usage-shared-workstation-axes.md §5.1의 409 SHARED_WORKSTATION 가드가 쓴다.
const sharedFindByIdMock = vi.fn()
// GET / 의 project_count 병합(api.md §5.6) — projects 테이블 GROUP BY 집계 대체.
const countAllByUserMock = vi.fn()

vi.mock('../dao/usage-shared-workstations.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, findById: (...args) => sharedFindByIdMock(...args) }
})

vi.mock('../dao/users.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    findById: (...args) => findByIdMock(...args),
    findByEmail: (...args) => findByEmailMock(...args),
    findByEmployeeId: (...args) => findByEmployeeIdMock(...args),
    insert: (...args) => insertMock(...args),
    listAll: (...args) => listAllMock(...args),
    buildUpdateEmployeeIdStatement: (...args) => buildUpdateEmployeeIdStatementMock(...args)
  }
})

vi.mock('../dao/projects.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, countAllByUser: (...args) => countAllByUserMock(...args) }
})

vi.mock('../dao/audit-logs.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, buildRecordStatementIfPrecedingChanged: (...args) => buildRecordStatementIfPrecedingChangedMock(...args) }
})

const { default: adminUsers } = await import('./admin-users.js')

const ADMIN_ID = 'admin-actor-id'
const TARGET_ID = '01k2s7m9f0abcdefghijklmnop'

function makeApp({ role = 'administrator' } = {}) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId', ADMIN_ID)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/users', adminUsers)
  return app
}

function targetRow(overrides = {}) {
  return { id: TARGET_ID, email: 'djkim@malgnsoft.com', name: '김덕조', role: 'administrator', status: 'active', employee_id: 'djkim', created_at: '2026-01-01T00:00:00.000Z', ...overrides }
}

// c.env.DB는 batch만 있는 목이다 — DAO(usersDao/auditLogsDao/sharedWorkstationsDao)는 전부
// vi.mock으로 대체돼 prepare를 호출하지 않는다. 공용 워크스테이션 가드가 추가되며 그 DAO도 함께
// 대체했다(계약을 낮춘 것이 아니라, 라우트 로직만 D1 없이 검증한다는 이 파일의 기존 방침 그대로다).
function putRequest(app, batch, body) {
  return app.request(
    `/api/admin/users/${TARGET_ID}/employee-id`,
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { DB: { batch } }
  )
}

function sharedRow(overrides = {}) {
  return { employee_id: 'claude', label: '3층 공용 PC', note: null, registered_by: '01kadminulid', created_at: '2026-09-08T02:00:00.000Z', updated_at: '2026-09-08T02:00:00.000Z', ...overrides }
}

beforeEach(() => {
  findByIdMock.mockReset()
  findByEmailMock.mockReset()
  findByEmployeeIdMock.mockReset()
  insertMock.mockReset()
  listAllMock.mockReset()
  countAllByUserMock.mockReset()
  buildUpdateEmployeeIdStatementMock.mockReset()
  buildRecordStatementIfPrecedingChangedMock.mockReset()
  sharedFindByIdMock.mockReset()
  buildUpdateEmployeeIdStatementMock.mockReturnValue({ __kind: 'update-stmt' })
  buildRecordStatementIfPrecedingChangedMock.mockReturnValue({ id: 'audit-id', stmt: { __kind: 'audit-stmt' } })
  sharedFindByIdMock.mockResolvedValue(null) // 기본: 공용 워크스테이션으로 등록되지 않은 값
  countAllByUserMock.mockResolvedValue(new Map())
})

// GET /api/admin/users — project_count 병합(api.md §5.6). usersDao.listAll과 projectsDao.countAllByUser를
// Promise.all로 병렬 호출한 뒤 메모리에서 merge한다(N+1 방지) — 두 DAO 모두 mock으로 대체해 D1 없이 검증.
describe('GET /api/admin/users — project_count 병합', () => {
  function getRequest(app) {
    return app.request('/api/admin/users', { method: 'GET' }, { DB: {} })
  }

  it('프로젝트가 없는 사용자는 project_count: 0', async () => {
    listAllMock.mockResolvedValue([targetRow({ id: 'user-no-projects', employee_id: null })])
    countAllByUserMock.mockResolvedValue(new Map()) // 아무도 프로젝트를 갖고 있지 않음
    const app = makeApp()

    const res = await getRequest(app)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].project_count).toBe(0)
  })

  it('여러 사용자 각각의 project_count가 집계 결과대로 정확히 매핑된다', async () => {
    listAllMock.mockResolvedValue([
      targetRow({ id: 'user-a', employee_id: 'a' }),
      targetRow({ id: 'user-b', employee_id: 'b' }),
      targetRow({ id: 'user-c', employee_id: 'c' })
    ])
    countAllByUserMock.mockResolvedValue(new Map([
      ['user-a', 3],
      ['user-b', 1]
      // user-c는 Map에 키 자체가 없음 — 0으로 기본 처리되어야 한다
    ]))
    const app = makeApp()

    const res = await getRequest(app)
    const body = await res.json()

    expect(res.status).toBe(200)
    const byId = Object.fromEntries(body.data.map((u) => [u.id, u.project_count]))
    expect(byId).toEqual({ 'user-a': 3, 'user-b': 1, 'user-c': 0 })
  })

  it('password_hash는 응답에 포함되지 않는다(toPublicUser 필드 화이트리스트 유지)', async () => {
    listAllMock.mockResolvedValue([targetRow({ id: 'user-a' })])
    countAllByUserMock.mockResolvedValue(new Map([['user-a', 2]]))
    const app = makeApp()

    const res = await getRequest(app)
    const body = await res.json()

    expect(body.data[0]).not.toHaveProperty('password_hash')
    expect(body.data[0].project_count).toBe(2)
  })
})

describe('PUT /api/admin/users/:id/employee-id — 권한·검증', () => {
  it('administrator가 아니면 403(requireAdmin, 라우터 전체 부착)', async () => {
    const app = makeApp({ role: 'employee' })
    const batch = vi.fn()
    const res = await putRequest(app, batch, { employee_id: 'malgn' })
    expect(res.status).toBe(403)
    expect(findByIdMock).not.toHaveBeenCalled()
    expect(batch).not.toHaveBeenCalled()
  })

  it('대상 사용자가 없으면 404', async () => {
    findByIdMock.mockResolvedValue(null)
    const app = makeApp()
    const res = await putRequest(app, vi.fn(), { employee_id: 'malgn' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
  })

  it('employee_id 키 자체가 없으면(undefined) 400 — null(해제)과 누락(실수)을 구분한다', async () => {
    findByIdMock.mockResolvedValue(targetRow())
    const app = makeApp()
    const res = await putRequest(app, vi.fn(), {})
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('형식 위반(허용목록 밖 문자)은 400', async () => {
    findByIdMock.mockResolvedValue(targetRow())
    const app = makeApp()
    const res = await putRequest(app, vi.fn(), { employee_id: 'a"b' })
    expect(res.status).toBe(400)
  })

  it('길이 상한(64자) 초과는 400(매처·PromQL로 흘러가지 않는다)', async () => {
    findByIdMock.mockResolvedValue(targetRow())
    const app = makeApp()
    const res = await putRequest(app, vi.fn(), { employee_id: 'a'.repeat(65) })
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/admin/users/:id/employee-id — no-op은 감사 미기록', () => {
  it('현재 값과 같은 값 재지정 → 200 + changed:false, batch·감사 둘 다 호출 안 함', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    const app = makeApp()
    const batch = vi.fn()
    const res = await putRequest(app, batch, { employee_id: 'djkim' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.changed).toBe(false)
    expect(body.previous_employee_id).toBe('djkim')
    expect(batch).not.toHaveBeenCalled()
    expect(buildRecordStatementIfPrecedingChangedMock).not.toHaveBeenCalled()
  })

  it('대소문자/공백만 다른 같은 값(정규화 후 동일)도 no-op으로 처리된다', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    const app = makeApp()
    const batch = vi.fn()
    const res = await putRequest(app, batch, { employee_id: '  DJKIM  ' })
    const body = await res.json()
    expect(body.changed).toBe(false)
    expect(batch).not.toHaveBeenCalled()
  })
})

describe('PUT /api/admin/users/:id/employee-id — 409 충돌(무언의 이전 금지)', () => {
  it('다른 사용자가 이미 그 값을 보유 → 409 + conflict_user_id/conflict_email, batch 호출 안 함(자동 이전 없음)', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    findByEmployeeIdMock.mockResolvedValue({ id: 'other-user-id', email: 'jh.lee@malgnsoft.com' })
    const app = makeApp()
    const batch = vi.fn()
    const res = await putRequest(app, batch, { employee_id: 'public' })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error.code).toBe('CONFLICT')
    expect(body.error.details.conflict_user_id).toBe('other-user-id')
    expect(body.error.details.conflict_email).toBe('jh.lee@malgnsoft.com')
    expect(batch).not.toHaveBeenCalled()
  })

  it('보유자가 자기 자신(id 동일)이면 충돌로 취급하지 않는다(재확인 경로)', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'old-value' }))
    findByEmployeeIdMock.mockResolvedValue({ id: TARGET_ID, email: 'djkim@malgnsoft.com' })
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])
    const res = await putRequest(app, batch, { employee_id: 'old-value-renamed' })
    // findByEmployeeId가 자기 자신을 반환해도(가정상 값이 다르지만) holder.id === id이므로 통과해야 한다
    expect(res.status).not.toBe(409)
  })

  it('사전 확인은 통과했지만 커밋 시점 UNIQUE 위반(경합) → 409로 매핑되고 재조회한 보유자 정보를 싣는다', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    findByEmployeeIdMock
      .mockResolvedValueOnce(null) // 사전 확인 통과
      .mockResolvedValueOnce({ id: 'racer-user-id', email: 'racer@malgnsoft.com' }) // 커밋 실패 후 재조회
    const app = makeApp()
    const batch = vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed: users.employee_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)'))
    const res = await putRequest(app, batch, { employee_id: 'public' })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error.details.conflict_user_id).toBe('racer-user-id')
    expect(batch).toHaveBeenCalledTimes(1)
  })

  it('UNIQUE 위반이 아닌 다른 D1 에러는 그대로 다시 던져진다(500)', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    findByEmployeeIdMock.mockResolvedValue(null)
    const app = makeApp()
    app.onError((err, c) => c.json({ error: { code: 'INTERNAL_ERROR', message: err.message } }, 500))
    const batch = vi.fn().mockRejectedValue(new Error('D1_ERROR: network timeout'))
    const res = await putRequest(app, batch, { employee_id: 'public' })
    expect(res.status).toBe(500)
  })

  // M-2 회귀(리뷰 2026-09-07) — 두 관리자가 동시에 같은 target을 편집: 둘 다 findByEmployeeId 사전
  // 확인은 통과하지만(서로 다른 값이라 충돌 없음), 뒤쳐진 쪽의 CAS UPDATE(WHERE employee_id IS
  // previousValue)가 0행이 된다. 감사 INSERT는 buildRecordStatementIfPrecedingChanged가 SQL
  // `WHERE (SELECT changes())>0`으로 스스로 no-op 처리하므로(dao/audit-logs.js), 여기서는 라우트가
  // updateResult.meta.changes===0을 보고 409 STALE_STATE로 응답하는지만 검증한다 — "일어나지 않은
  // 변경"이 200으로 위장되지 않는다.
  it('CAS 불일치(동시 편집으로 employee_id가 이미 바뀜) → batch는 던지지 않지만 meta.changes===0 → 409 STALE_STATE, 성공 응답 아님', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' })) // 이 요청이 읽은 시점의 값(이미 stale)
    findByEmployeeIdMock.mockResolvedValue(null) // 새 값 'malgn'은 아무도 안 씀(사전 확인 통과)
    const app = makeApp()
    // CAS 조건 불일치로 UPDATE가 0행 — batch 자체는 예외 없이 resolve된다(UNIQUE 위반이 아니므로).
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 0 } }, { meta: { changes: 0 } }])
    const res = await putRequest(app, batch, { employee_id: 'malgn' })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error.code).toBe('STALE_STATE')
    expect(batch).toHaveBeenCalledTimes(1)
    // CAS 바인딩 값 확인 — WHERE employee_id IS ? 에 이 요청이 읽은 'djkim'이 그대로 들어갔다.
    expect(buildUpdateEmployeeIdStatementMock).toHaveBeenCalledWith(expect.anything(), TARGET_ID, 'malgn', 'djkim')
  })
})

// docs/design/usage-shared-workstation-axes.md §5.1 — 등록된 공용 워크스테이션 축(여러 명이 함께
// 쓰는 PC)을 개인 계정에 연결하면 그룹 전체 사용량이 한 사람의 개인 사용량으로 표시된다.
// 강제 우회(force)를 두지 않는다: 정당한 연결이 필요하면 먼저 레지스트리에서 해제해야 한다.
describe('PUT /api/admin/users/:id/employee-id — 409 SHARED_WORKSTATION(공용 축 연결 차단)', () => {
  it('등록된 공용 값을 연결하려 하면 409 SHARED_WORKSTATION + details, batch 미호출, 감사 미기록', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    sharedFindByIdMock.mockResolvedValue(sharedRow())
    const app = makeApp()
    const batch = vi.fn()

    const res = await putRequest(app, batch, { employee_id: 'claude' })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error.code).toBe('SHARED_WORKSTATION')
    expect(body.error.details).toEqual({
      employee_id: 'claude',
      label: '3층 공용 PC',
      registered_at: '2026-09-08T02:00:00.000Z',
      registered_by_user_id: '01kadminulid'
    })
    expect(batch).not.toHaveBeenCalled() // users 행 불변
    expect(buildRecordStatementIfPrecedingChangedMock).not.toHaveBeenCalled() // 감사 증가 0
    expect(sharedFindByIdMock).toHaveBeenCalledWith(expect.anything(), 'claude') // 정규화된 값으로 조회
  })

  it('force/confirm 같은 우회 플래그를 실어도 차단은 그대로다(우회 경로 없음)', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    sharedFindByIdMock.mockResolvedValue(sharedRow())
    const app = makeApp()
    const batch = vi.fn()

    const res = await putRequest(app, batch, { employee_id: 'claude', force: true, confirm: true })

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SHARED_WORKSTATION')
    expect(batch).not.toHaveBeenCalled()
  })

  it('해제(null)는 현재 값이 공용 축이어도 항상 성공한다 — 잘못된 상태의 탈출구를 막지 않는다', async () => {
    findByIdMock
      .mockResolvedValueOnce(targetRow({ employee_id: 'claude' })) // 현재 값이 공용 축(모순 상태)
      .mockResolvedValueOnce(targetRow({ employee_id: null }))
    sharedFindByIdMock.mockResolvedValue(sharedRow()) // 등록돼 있어도
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])

    const res = await putRequest(app, batch, { employee_id: null })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.changed).toBe(true)
    expect(body.user.employee_id).toBeNull()
    expect(batch).toHaveBeenCalledTimes(1)
    expect(sharedFindByIdMock).not.toHaveBeenCalled() // null은 레지스트리 조회 자체를 하지 않는다
  })

  it('레지스트리 조회가 실패하면 fail-open 하지 않는다 — 연결을 통과시키지 않고 5xx로 떨어진다', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    sharedFindByIdMock.mockRejectedValue(new Error('D1_ERROR: connection lost'))
    const app = makeApp()
    app.onError((err, c) => c.json({ error: { code: 'INTERNAL_ERROR', message: err.message } }, 500))
    const batch = vi.fn()

    const res = await putRequest(app, batch, { employee_id: 'claude' })

    expect(res.status).toBe(500)
    expect(batch).not.toHaveBeenCalled() // 안전장치가 장애 시 자동으로 꺼지지 않는다
    expect(findByEmployeeIdMock).not.toHaveBeenCalled()
  })

  it('공용 등록 + 타 사용자 보유가 동시에 성립하면 오류 우선순위가 결정적이다 — 항상 SHARED_WORKSTATION', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    sharedFindByIdMock.mockResolvedValue(sharedRow())
    findByEmployeeIdMock.mockResolvedValue({ id: 'other-user-id', email: 'jh.lee@malgnsoft.com' })
    const app = makeApp()
    const batch = vi.fn()

    const res = await putRequest(app, batch, { employee_id: 'claude' })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error.code).toBe('SHARED_WORKSTATION') // CONFLICT가 아니다(먼저 할 조치가 등록 해제)
    // 보유자 검사에 도달하지도 않는다 — 순서가 코드로 고정돼 있다.
    expect(findByEmployeeIdMock).not.toHaveBeenCalled()
    expect(batch).not.toHaveBeenCalled()
  })

  it('경합(사전 검사 통과 후 공용 등록됨) → UPDATE 0행 재판정으로 STALE_STATE가 아니라 SHARED_WORKSTATION', async () => {
    findByIdMock.mockResolvedValue(targetRow({ employee_id: 'djkim' }))
    findByEmployeeIdMock.mockResolvedValue(null)
    sharedFindByIdMock
      .mockResolvedValueOnce(null) // 사전 검사 시점: 아직 등록 안 됨(통과)
      .mockResolvedValueOnce(sharedRow()) // 커밋 직전에 다른 관리자가 등록 → UPDATE WHERE NOT EXISTS가 0행
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 0 } }, { meta: { changes: 0 } }])

    const res = await putRequest(app, batch, { employee_id: 'claude' })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error.code).toBe('SHARED_WORKSTATION')
    expect(body.error.details.employee_id).toBe('claude')
  })

  it('등록되지 않은 값은 기존 경로 그대로 통과한다(등록 전까지 동작 무변경)', async () => {
    findByIdMock
      .mockResolvedValueOnce(targetRow({ employee_id: 'djkim' }))
      .mockResolvedValueOnce(targetRow({ employee_id: 'malgn' }))
    findByEmployeeIdMock.mockResolvedValue(null)
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])

    const res = await putRequest(app, batch, { employee_id: 'malgn' })

    expect(res.status).toBe(200)
    expect(batch).toHaveBeenCalledTimes(1)
  })
})

describe('PUT /api/admin/users/:id/employee-id — 원자 커밋·감사로그·응답', () => {
  it('정상 연결 변경 → db.batch([update, audit]) 원자 커밋 + 200 + warnings 계산', async () => {
    findByIdMock
      .mockResolvedValueOnce(targetRow({ employee_id: 'djkim' })) // 라우트 진입 시 조회
      .mockResolvedValueOnce(targetRow({ employee_id: 'malgn' })) // 갱신 후 재조회
    findByEmployeeIdMock.mockResolvedValue(null) // 보유자 없음
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ success: true, meta: { changes: 1 } }, { success: true, meta: { changes: 1 } }])

    const res = await putRequest(app, batch, { employee_id: 'malgn' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.changed).toBe(true)
    expect(body.previous_employee_id).toBe('djkim')
    expect(body.user.employee_id).toBe('malgn')
    expect(body.warnings).toContain('local_part_mismatch') // 'malgn' !== employeeIdFromEmail('djkim@malgnsoft.com')='djkim'
    expect(body.warnings).toContain('overwrote_existing_link') // 이전 값('djkim')이 존재했다

    // 원자 커밋 — UPDATE statement와 audit statement가 하나의 batch 배열로 함께 전달된다.
    expect(batch).toHaveBeenCalledTimes(1)
    const batchArg = batch.mock.calls[0][0]
    expect(batchArg).toEqual([{ __kind: 'update-stmt' }, { __kind: 'audit-stmt' }])

    // 감사로그 메타데이터 — before/after/target_email/local_part_mismatch
    expect(buildRecordStatementIfPrecedingChangedMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorUserId: ADMIN_ID,
      action: 'user.employee_id_changed',
      targetType: 'user',
      targetId: TARGET_ID,
      metadata: expect.objectContaining({ before: 'djkim', after: 'malgn', target_email: 'djkim@malgnsoft.com', local_part_mismatch: true })
    }))

    // M-2 — CAS: UPDATE statement 빌더에 previousValue(batch 밖에서 읽은 target.employee_id)가
    // 네 번째 인자로 그대로 전달된다(WHERE employee_id IS ?의 바인딩 값).
    expect(buildUpdateEmployeeIdStatementMock).toHaveBeenCalledWith(expect.anything(), TARGET_ID, 'malgn', 'djkim')
  })

  it('연결 해제(employee_id: null) → warnings에 local_part_mismatch는 없고 overwrote_existing_link만 있다', async () => {
    findByIdMock
      .mockResolvedValueOnce(targetRow({ employee_id: 'djkim' }))
      .mockResolvedValueOnce(targetRow({ employee_id: null }))
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])

    const res = await putRequest(app, batch, { employee_id: null })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.changed).toBe(true)
    expect(body.user.employee_id).toBeNull()
    expect(body.warnings).toEqual(['overwrote_existing_link'])
    expect(findByEmployeeIdMock).not.toHaveBeenCalled() // null 지정은 보유자 확인 자체가 필요 없다
  })

  it('처음 연결(이전 값 없음, 로컬파트와 일치) → warnings 빈 배열', async () => {
    findByIdMock
      .mockResolvedValueOnce(targetRow({ employee_id: null }))
      .mockResolvedValueOnce(targetRow({ employee_id: 'djkim' }))
    findByEmployeeIdMock.mockResolvedValue(null)
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])

    const res = await putRequest(app, batch, { employee_id: 'djkim' })
    const body = await res.json()

    expect(body.warnings).toEqual([])
    expect(body.previous_employee_id).toBeNull()
  })
})

describe('POST /api/admin/users — §5.8 신규 계정 employee_id 기본값(M-4 수정, 리뷰 2026-09-07: 자동 부여 폐지)', () => {
  function postBody(overrides = {}) {
    return { email: 'newhire@malgnsoft.com', name: '신입', role: 'employee', ...overrides }
  }

  function postApp(body) {
    const app = makeApp()
    return app.request(
      '/api/admin/users',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      { DB: {} } // POST 라우트는 DB.batch를 쓰지 않는다(findByEmail/findByEmployeeId/insert 전부 mock) — c.env.DB가 정의만 되면 충분하다
    )
  }

  // M-4 — "users 중 아무도 안 씀"만으로는 주인 없는 관측 축(Prometheus에서 이미 관측 중인데 어떤
  // 허브 계정에도 안 걸린 employee_id)과 정말 미사용인 값을 구분할 수 없다. 자동 부여를 껐으므로
  // 로컬파트가 유효하고 미보유여도 employee_id는 NULL로 남고, 후보값은 warnings로만 안내한다.
  it('로컬파트가 유효하고 아무도 안 쓰면 → employee_id는 NULL로 남고 warnings:["employee_id_not_auto_linked"](자동 연결 안 함, 감사로그 없는 경로라 사람이 PUT으로 명시 연결해야 한다)', async () => {
    findByEmailMock.mockResolvedValue(null) // 이메일 중복 없음
    findByEmployeeIdMock.mockResolvedValue(null) // 로컬파트 미보유 — 그래도 자동 연결하지 않는다
    insertMock.mockImplementation(async (db, { email, name, role, employeeId }) => (
      { id: 'new-user-id', email, name, role, status: 'active', employee_id: employeeId, created_at: '2026-09-07T00:00:00.000Z' }
    ))

    const res = await postApp(postBody())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.employee_id).toBeNull()
    expect(body.warnings).toEqual(['employee_id_not_auto_linked'])
    expect(insertMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ employeeId: null }))
  })

  it('로컬파트가 이미 쓰이고 있으면 employee_id NULL + warnings:["employee_id_taken"](계정 생성 자체는 성공)', async () => {
    findByEmailMock.mockResolvedValue(null)
    findByEmployeeIdMock.mockResolvedValue({ id: 'existing-holder', email: 'newhire@otherco.example' })
    insertMock.mockImplementation(async (db, { email, name, role, employeeId }) => (
      { id: 'new-user-id', email, name, role, status: 'active', employee_id: employeeId, created_at: '2026-09-07T00:00:00.000Z' }
    ))

    const res = await postApp(postBody())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.employee_id).toBeNull()
    expect(body.warnings).toEqual(['employee_id_taken'])
    expect(insertMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ employeeId: null }))
  })

  it('이메일 로컬파트가 employee_id 허용목록 밖 문자를 포함하면 employee_id NULL + warnings:["employee_id_underivable"]', async () => {
    findByEmailMock.mockResolvedValue(null)
    insertMock.mockImplementation(async (db, { email, name, role, employeeId }) => (
      { id: 'new-user-id', email, name, role, status: 'active', employee_id: employeeId, created_at: '2026-09-07T00:00:00.000Z' }
    ))

    const res = await postApp(postBody({ email: 'new!hire@malgnsoft.com' }))
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.employee_id).toBeNull()
    expect(body.warnings).toEqual(['employee_id_underivable'])
    expect(findByEmployeeIdMock).not.toHaveBeenCalled() // 파생조차 안 됐으니 보유자 조회를 시도하지 않는다
  })

  it('이메일 중복(기존 계정)이면 여전히 409를 먼저 반환한다(employee_id 로직 도달 전)', async () => {
    findByEmailMock.mockResolvedValue({ id: 'existing', email: 'newhire@malgnsoft.com' })
    const res = await postApp(postBody())
    expect(res.status).toBe(409)
    expect(findByEmployeeIdMock).not.toHaveBeenCalled()
    expect(insertMock).not.toHaveBeenCalled()
  })
})
