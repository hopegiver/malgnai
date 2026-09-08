// GET/PUT/DELETE /api/admin/usage/shared-workstations 라우트 레벨 단위테스트.
// 설계 정본: docs/design/usage-shared-workstation-axes.md §5.3
// Sensitive 등급 — 이 레지스트리가 "누구의 사용량인가"를 바꾸는 유일한 정본이라 인가·역방향 충돌·
// 원자 커밋·감사 무기록을 각각 별도로 증명한다.
//
// server/dao/usage-shared-workstations.js는 조회/갱신 함수만 대체하고 statement 빌더는 마커 객체를
// 돌려주게 해 db.batch()에 무엇이 어떤 순서로 들어가는지 그대로 관찰한다. c.env.DB.batch()는 이
// 파일이 직접 제어하는 vi.fn()이다(D1 없이 라우트 로직만 검증 — admin-users.test.js와 같은 방침).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const listAllMock = vi.fn()
const findByIdMock = vi.fn()
const updateLabelMock = vi.fn()
const buildInsertIfUnheldStatementMock = vi.fn()
const buildDeleteStatementMock = vi.fn()
const findByEmployeeIdMock = vi.fn()
const buildRecordStatementIfPrecedingChangedMock = vi.fn()

vi.mock('../dao/usage-shared-workstations.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    listAll: (...args) => listAllMock(...args),
    findById: (...args) => findByIdMock(...args),
    updateLabel: (...args) => updateLabelMock(...args),
    buildInsertIfUnheldStatement: (...args) => buildInsertIfUnheldStatementMock(...args),
    buildDeleteStatement: (...args) => buildDeleteStatementMock(...args)
  }
})

vi.mock('../dao/users.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, findByEmployeeId: (...args) => findByEmployeeIdMock(...args) }
})

vi.mock('../dao/audit-logs.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, buildRecordStatementIfPrecedingChanged: (...args) => buildRecordStatementIfPrecedingChangedMock(...args) }
})

const { default: adminSharedWorkstations } = await import('./admin-shared-workstations.js')

const ADMIN_ID = 'admin-actor-id'
const BASE = '/api/admin/usage/shared-workstations'

function makeApp({ role = 'administrator', authenticated = true } = {}) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (authenticated) {
      c.set('userId', ADMIN_ID)
      c.set('userRole', role)
    }
    await next()
  })
  app.route(BASE, adminSharedWorkstations)
  return app
}

function row(overrides = {}) {
  return {
    employee_id: 'claude',
    label: '3층 공용 PC',
    note: '영업팀 공용, 4~5명 사용',
    registered_by: ADMIN_ID,
    created_at: '2026-09-08T02:00:00.000Z',
    updated_at: '2026-09-08T02:00:00.000Z',
    ...overrides
  }
}

function put(app, batch, employeeId, body = {}) {
  return app.request(
    `${BASE}/${employeeId}`,
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { DB: { batch } }
  )
}

function del(app, batch, employeeId) {
  return app.request(`${BASE}/${employeeId}`, { method: 'DELETE' }, { DB: { batch } })
}

beforeEach(() => {
  listAllMock.mockReset()
  findByIdMock.mockReset()
  updateLabelMock.mockReset()
  buildInsertIfUnheldStatementMock.mockReset()
  buildDeleteStatementMock.mockReset()
  findByEmployeeIdMock.mockReset()
  buildRecordStatementIfPrecedingChangedMock.mockReset()
  buildInsertIfUnheldStatementMock.mockReturnValue({ __kind: 'insert-stmt' })
  buildDeleteStatementMock.mockReturnValue({ __kind: 'delete-stmt' })
  buildRecordStatementIfPrecedingChangedMock.mockReturnValue({ id: 'audit-id', stmt: { __kind: 'audit-stmt' } })
  updateLabelMock.mockResolvedValue({ meta: { changes: 1 } })
})

describe('권한 — requireAdmin이 라우터 전체에 부착돼 있다', () => {
  it('employee 역할이면 403(3개 라우트 전부)', async () => {
    const app = makeApp({ role: 'employee' })
    const batch = vi.fn()

    expect((await app.request(BASE, {}, { DB: {} })).status).toBe(403)
    expect((await put(app, batch, 'claude')).status).toBe(403)
    expect((await del(app, batch, 'claude')).status).toBe(403)

    expect(listAllMock).not.toHaveBeenCalled()
    expect(findByIdMock).not.toHaveBeenCalled()
    expect(batch).not.toHaveBeenCalled()
  })

  // 미인증 401은 이 라우터가 아니라 전역 jwtAuthMiddleware(server/index.js가 /api/*에 부착)가 낸다.
  // 여기서 검증하는 것은 그 미들웨어가 없을 때 requireAdmin이 fail-closed(403)로 막는지다 —
  // userRole이 비어 있으면 절대 통과하지 않는다.
  it('userRole이 설정되지 않으면(인증 컨텍스트 없음) fail-closed로 403 — 통과하지 않는다', async () => {
    const app = makeApp({ authenticated: false })
    const res = await app.request(BASE, {}, { DB: {} })
    expect(res.status).toBe(403)
    expect(listAllMock).not.toHaveBeenCalled()
  })
})

describe('GET / — 목록', () => {
  it('employee_id ASC 순서 그대로 공개 필드만 반환한다', async () => {
    listAllMock.mockResolvedValue([row({ employee_id: 'claude' }), row({ employee_id: 'malgn', label: null, note: null, registered_by: null })])
    const app = makeApp()

    const res = await app.request(BASE, {}, { DB: {} })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.map((r) => r.employee_id)).toEqual(['claude', 'malgn'])
    expect(body.data[1]).toEqual({
      employee_id: 'malgn', label: null, note: null, registered_by: null,
      created_at: '2026-09-08T02:00:00.000Z', updated_at: '2026-09-08T02:00:00.000Z'
    })
  })
})

describe('PUT /:employeeId — 등록·갱신', () => {
  it('신규 등록 → 201 + created:true + 감사 1건이 조건부 INSERT와 같은 batch로 원자 커밋된다', async () => {
    findByIdMock
      .mockResolvedValueOnce(null) // 아직 등록 안 됨
      .mockResolvedValueOnce(row()) // 커밋 후 재조회
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])

    const res = await put(app, batch, 'claude', { label: '3층 공용 PC', note: '영업팀 공용, 4~5명 사용' })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.created).toBe(true)
    expect(body.shared_workstation.employee_id).toBe('claude')
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0][0]).toEqual([{ __kind: 'insert-stmt' }, { __kind: 'audit-stmt' }])

    // 감사 액션은 1개로 통합하고 등록/해제는 metadata.op로 구분한다(migrations/0023).
    expect(buildRecordStatementIfPrecedingChangedMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorUserId: ADMIN_ID,
      action: 'shared_workstation.changed',
      targetType: 'shared_workstation',
      targetId: 'claude',
      metadata: { op: 'registered', label: '3층 공용 PC', note: '영업팀 공용, 4~5명 사용' }
    }))
    expect(buildInsertIfUnheldStatementMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      employeeId: 'claude', label: '3층 공용 PC', registeredBy: ADMIN_ID
    }))
  })

  it('이미 등록된 축의 라벨 갱신 → 200 + created:false + 감사 증가 0(라벨은 귀속을 바꾸지 않는다)', async () => {
    findByIdMock
      .mockResolvedValueOnce(row()) // 이미 존재
      .mockResolvedValueOnce(row({ label: '2층 공용 PC' }))
    const app = makeApp()
    const batch = vi.fn()

    const res = await put(app, batch, 'claude', { label: '2층 공용 PC' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.created).toBe(false)
    expect(body.shared_workstation.label).toBe('2층 공용 PC')
    expect(batch).not.toHaveBeenCalled()
    expect(buildRecordStatementIfPrecedingChangedMock).not.toHaveBeenCalled()
    expect(updateLabelMock).toHaveBeenCalledTimes(1)
  })

  it('역방향 가드 — 어떤 회원이 그 값을 보유 중이면 409 CONFLICT + conflict_user_id, 감사 증가 0', async () => {
    findByIdMock.mockResolvedValue(null)
    findByEmployeeIdMock.mockResolvedValue({ id: 'holder-user-id', email: 'djkim@malgnsoft.com' })
    const app = makeApp()
    // 조건부 INSERT(WHERE NOT EXISTS)가 0행 — 보유자가 있어 등록되지 않았다.
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 0 } }, { meta: { changes: 0 } }])

    const res = await put(app, batch, 'djkim', { label: '오등록 시도' })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error.code).toBe('CONFLICT')
    expect(body.error.details.conflict_user_id).toBe('holder-user-id')
    expect(body.error.details.conflict_email).toBe('djkim@malgnsoft.com')
    // 감사 statement는 batch에 실렸지만 SQL 수준에서 함께 no-op이다 — 라우트가 별도로 기록하지 않는다.
    expect(batch).toHaveBeenCalledTimes(1)
  })

  it('두 관리자가 같은 축을 동시 등록(PK 충돌)하면 "이미 존재"(200, created:false)로 수렴한다(S5)', async () => {
    findByIdMock
      .mockResolvedValueOnce(null) // 사전 확인: 없음
      .mockResolvedValueOnce(row()) // 충돌 후 재조회: 상대가 먼저 넣었다
      .mockResolvedValueOnce(row({ label: '내 라벨' }))
    const app = makeApp()
    const batch = vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed: usage_shared_workstations.employee_id: SQLITE_CONSTRAINT'))

    const res = await put(app, batch, 'claude', { label: '내 라벨' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.created).toBe(false)
    expect(updateLabelMock).toHaveBeenCalledTimes(1)
  })

  it('제약 위반이 아닌 D1 에러는 그대로 다시 던져진다(500)', async () => {
    findByIdMock.mockResolvedValue(null)
    const app = makeApp()
    app.onError((err, c) => c.json({ error: { code: 'INTERNAL_ERROR', message: err.message } }, 500))
    const batch = vi.fn().mockRejectedValue(new Error('D1_ERROR: network timeout'))

    const res = await put(app, batch, 'claude')
    expect(res.status).toBe(500)
  })

  // 대소문자는 "형식 위반"이 아니라 정규화 대상이다 — 레지스트리 키는 소문자 정본이고 Prometheus
  // 라벨도 unitIdentityFromLabels가 소문자화하므로 'Claude'와 'claude'는 같은 축을 가리킨다.
  // PUT /api/admin/users/:id/employee-id가 본문 값을 소문자화하는 것과 같은 규칙이다(정본 하나).
  it('경로 파라미터의 대문자·앞뒤 공백은 형식 위반이 아니라 소문자로 정규화된다(같은 축을 가리킨다)', async () => {
    findByIdMock.mockResolvedValueOnce(null).mockResolvedValueOnce(row())
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])

    const res = await put(app, batch, '%20Claude%20', { label: 'x' })

    expect(res.status).toBe(201)
    expect(findByIdMock).toHaveBeenCalledWith(expect.anything(), 'claude')
    expect(buildInsertIfUnheldStatementMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ employeeId: 'claude' }))
  })

  it.each([
    ['내부 공백', 'a%20b'],
    ['허용목록 밖 문자(따옴표)', 'a%22b'],
    ['허용목록 밖 문자(중괄호 — 라벨 매처 인젝션 시도)', 'a%7Buser_email%3D~%22.*%22%7D'],
    ['한글', '%EA%B9%80%EB%8F%84%ED%98%95'],
    ['64자 초과', 'a'.repeat(65)]
  ])('경로 파라미터 형식 위반(%s) → 400, D1을 건드리지 않는다', async (_label, employeeId) => {
    const app = makeApp()
    const batch = vi.fn()

    const res = await put(app, batch, employeeId, { label: 'x' })

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(findByIdMock).not.toHaveBeenCalled()
    expect(batch).not.toHaveBeenCalled()
  })

  it('label이 100자를 넘으면 400, note가 500자를 넘으면 400', async () => {
    findByIdMock.mockResolvedValue(null)
    const app = makeApp()
    const batch = vi.fn()

    expect((await put(app, batch, 'claude', { label: 'a'.repeat(101) })).status).toBe(400)
    expect((await put(app, batch, 'claude', { note: 'a'.repeat(501) })).status).toBe(400)
    expect((await put(app, batch, 'claude', { label: 123 })).status).toBe(400)
    expect(batch).not.toHaveBeenCalled()
  })

  it('label 생략·빈 문자열은 NULL로 정규화된다(두 표현을 남기지 않는다)', async () => {
    findByIdMock.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ label: null }))
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])

    await put(app, batch, 'claude', { label: '   ' })

    expect(buildInsertIfUnheldStatementMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ label: null, note: null }))
  })

  it('본문의 employee_id는 무시된다 — 경로가 정본이라 두 값이 어긋나는 상태를 만들지 않는다', async () => {
    findByIdMock.mockResolvedValueOnce(null).mockResolvedValueOnce(row())
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])

    await put(app, batch, 'claude', { employee_id: 'malgn', label: 'x' })

    expect(buildInsertIfUnheldStatementMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ employeeId: 'claude' }))
  })
})

describe('DELETE /:employeeId — 해제', () => {
  it('등록된 축 해제 → 200 + 감사 1건(metadata.op=unregistered, 삭제 전 라벨·메모 보존)', async () => {
    findByIdMock.mockResolvedValue(row())
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])

    const res = await del(app, batch, 'claude')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ employee_id: 'claude', deleted: true })
    expect(batch.mock.calls[0][0]).toEqual([{ __kind: 'delete-stmt' }, { __kind: 'audit-stmt' }])
    expect(buildRecordStatementIfPrecedingChangedMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'shared_workstation.changed',
      targetType: 'shared_workstation',
      targetId: 'claude',
      metadata: { op: 'unregistered', label: '3층 공용 PC', note: '영업팀 공용, 4~5명 사용' }
    }))
  })

  it('등록되지 않은 값 해제 → 404, batch 미호출', async () => {
    findByIdMock.mockResolvedValue(null)
    const app = makeApp()
    const batch = vi.fn()

    const res = await del(app, batch, 'nobody')

    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
    expect(batch).not.toHaveBeenCalled()
  })

  it('그 사이 다른 관리자가 이미 해제했으면(DELETE 0행) 404 — 없던 해제가 성공으로 위장되지 않는다', async () => {
    findByIdMock.mockResolvedValue(row())
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 0 } }, { meta: { changes: 0 } }])

    const res = await del(app, batch, 'claude')

    expect(res.status).toBe(404)
  })

  it('경로 파라미터 형식 위반은 400(D1을 건드리지 않는다)', async () => {
    const app = makeApp()
    const batch = vi.fn()
    const res = await del(app, batch, 'a%22b')
    expect(res.status).toBe(400)
    expect(findByIdMock).not.toHaveBeenCalled()
    expect(batch).not.toHaveBeenCalled()
  })

  it('대문자 경로도 소문자로 정규화해 같은 축을 해제한다', async () => {
    findByIdMock.mockResolvedValue(row())
    const app = makeApp()
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }])

    const res = await del(app, batch, 'CLAUDE')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.employee_id).toBe('claude')
    expect(findByIdMock).toHaveBeenCalledWith(expect.anything(), 'claude')
  })
})
