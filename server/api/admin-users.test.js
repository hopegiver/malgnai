// PUT /api/admin/users/:id/employee-id + POST /api/admin/users(§5.8 기본값) 라우트 레벨 단위테스트.
// docs/design/usage-employee-identity-linking.md 정본 — Sensitive 등급(식별자 재연결 = IDOR과
// 같은 부류의 조작)이라 403/409/원자 커밋/no-op 무기록을 각각 별도로 증명한다.
// server/dao/users.js는 findById/findByEmployeeId/buildUpdateEmployeeIdStatement만 대체,
// server/dao/audit-logs.js는 buildRecordStatement만 대체해 D1 없이 라우트 로직만 검증한다.
// c.env.DB.batch()는 이 파일이 직접 제어하는 vi.fn()이다(원자 커밋 여부·인자를 그대로 관찰한다).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const findByIdMock = vi.fn()
const findByEmailMock = vi.fn()
const findByEmployeeIdMock = vi.fn()
const insertMock = vi.fn()
const buildUpdateEmployeeIdStatementMock = vi.fn()
const buildRecordStatementMock = vi.fn()

vi.mock('../dao/users.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    findById: (...args) => findByIdMock(...args),
    findByEmail: (...args) => findByEmailMock(...args),
    findByEmployeeId: (...args) => findByEmployeeIdMock(...args),
    insert: (...args) => insertMock(...args),
    buildUpdateEmployeeIdStatement: (...args) => buildUpdateEmployeeIdStatementMock(...args)
  }
})

vi.mock('../dao/audit-logs.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, buildRecordStatement: (...args) => buildRecordStatementMock(...args) }
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

function putRequest(app, batch, body) {
  return app.request(
    `/api/admin/users/${TARGET_ID}/employee-id`,
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { DB: { batch } }
  )
}

beforeEach(() => {
  findByIdMock.mockReset()
  findByEmailMock.mockReset()
  findByEmployeeIdMock.mockReset()
  insertMock.mockReset()
  buildUpdateEmployeeIdStatementMock.mockReset()
  buildRecordStatementMock.mockReset()
  buildUpdateEmployeeIdStatementMock.mockReturnValue({ __kind: 'update-stmt' })
  buildRecordStatementMock.mockReturnValue({ id: 'audit-id', stmt: { __kind: 'audit-stmt' } })
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
    expect(buildRecordStatementMock).not.toHaveBeenCalled()
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
    const batch = vi.fn().mockResolvedValue([{}, {}])
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
})

describe('PUT /api/admin/users/:id/employee-id — 원자 커밋·감사로그·응답', () => {
  it('정상 연결 변경 → db.batch([update, audit]) 원자 커밋 + 200 + warnings 계산', async () => {
    findByIdMock
      .mockResolvedValueOnce(targetRow({ employee_id: 'djkim' })) // 라우트 진입 시 조회
      .mockResolvedValueOnce(targetRow({ employee_id: 'malgn' })) // 갱신 후 재조회
    findByEmployeeIdMock.mockResolvedValue(null) // 보유자 없음
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ success: true }, { success: true }])

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
    expect(buildRecordStatementMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorUserId: ADMIN_ID,
      action: 'user.employee_id_changed',
      targetType: 'user',
      targetId: TARGET_ID,
      metadata: expect.objectContaining({ before: 'djkim', after: 'malgn', target_email: 'djkim@malgnsoft.com', local_part_mismatch: true })
    }))
  })

  it('연결 해제(employee_id: null) → warnings에 local_part_mismatch는 없고 overwrote_existing_link만 있다', async () => {
    findByIdMock
      .mockResolvedValueOnce(targetRow({ employee_id: 'djkim' }))
      .mockResolvedValueOnce(targetRow({ employee_id: null }))
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{}, {}])

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
    const batch = vi.fn().mockResolvedValue([{}, {}])

    const res = await putRequest(app, batch, { employee_id: 'djkim' })
    const body = await res.json()

    expect(body.warnings).toEqual([])
    expect(body.previous_employee_id).toBeNull()
  })
})

describe('POST /api/admin/users — §5.8 신규 계정 employee_id 기본값', () => {
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

  it('로컬파트가 유효하고 아무도 안 쓰면 기본값으로 채운다(warnings 없음)', async () => {
    findByEmailMock.mockResolvedValue(null) // 이메일 중복 없음
    findByEmployeeIdMock.mockResolvedValue(null) // 로컬파트 미보유
    insertMock.mockImplementation(async (db, { email, name, role, employeeId }) => (
      { id: 'new-user-id', email, name, role, status: 'active', employee_id: employeeId, created_at: '2026-09-07T00:00:00.000Z' }
    ))

    const res = await postApp(postBody())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.employee_id).toBe('newhire')
    expect(body.warnings).toEqual([])
    expect(insertMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ employeeId: 'newhire' }))
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
