// server/lib/usage-identity.js 단위테스트 — docs/design/usage-employee-identity.md §3.4 순수 함수
// 6개(+ 매처 조립 헬퍼) 전체를 커버한다. 특히 resolveEmployeeScope()의 IDOR 회귀 테스트(§6.2
// 불변식 I1)가 이 파일의 핵심 — "안전하지 않은 employee_id를 받았을 때 matchers: []를 반환하되
// scoped: true를 유지"하고 "호출부가 라이브 질의를 생략"하는 것(무필터 전사 조회로 뒤집히지 않는
// 것)을 단언한다.
import { describe, it, expect } from 'vitest'
import {
  EMPLOYEE_ID_RE,
  MAX_EMPLOYEE_ID_LENGTH,
  employeeIdFromEmail,
  isPromSafeEmployeeId,
  normalizeEmployeeIdInput,
  pickSharedWorkstationName,
  escapeLabelValue,
  employeeIdMatcher,
  resolveEmployeeScope,
  decodeEmployeeName,
  pickDisplayName
} from './usage-identity.js'

describe('employeeIdFromEmail — D1 users.email → employee_id(§3.2 단방향 규칙)', () => {
  it('정상 이메일은 로컬파트를 소문자로 추출한다', () => {
    expect(employeeIdFromEmail('Hopegiver@Malgnsoft.com')).toBe('hopegiver')
  })

  it('이미 소문자인 이메일도 그대로 통과한다', () => {
    expect(employeeIdFromEmail('dev@malgnsoft.com')).toBe('dev')
  })

  it.each([
    ["'@' 없음", 'not-an-email'],
    ["로컬파트가 빈 문자열('@'로 시작)", '@malgnsoft.com'],
    ['허용목록 밖 문자(공백)', 'a b@malgnsoft.com'],
    ['허용목록 밖 문자(큰따옴표)', 'a"b@malgnsoft.com'],
    ['문자열이 아님(null)', null],
    ['문자열이 아님(undefined)', undefined],
    ['문자열이 아님(숫자)', 12345],
    ['빈 문자열', '']
  ])('%s → null', (_label, value) => {
    expect(employeeIdFromEmail(value)).toBeNull()
  })

  it('EMPLOYEE_ID_RE는 로컬파트에 흔한 문자(점·언더스코어·플러스·하이픈)를 허용한다', () => {
    expect(employeeIdFromEmail('first.last+tag_1-x@malgnsoft.com')).toBe('first.last+tag_1-x')
  })
})

describe('isPromSafeEmployeeId — 매처 삽입 직전 방어선(§4.4, defense in depth)', () => {
  it('EMPLOYEE_ID_RE를 통과하는 값은 안전하다', () => {
    expect(isPromSafeEmployeeId('hopegiver')).toBe(true)
  })

  it.each([
    ['빈 문자열', ''],
    ['공백 포함', 'a b'],
    ['큰따옴표 포함(라벨 매처 탈출 시도)', 'a"b'],
    ['중괄호 포함(새 매처 삽입 시도)', 'a{user_email=~".*"}'],
    ['문자열이 아님(null)', null],
    ['문자열이 아님(숫자)', 12345]
  ])('%s → 거부', (_label, value) => {
    expect(isPromSafeEmployeeId(value)).toBe(false)
  })

  it('EMPLOYEE_ID_RE 자체도 같은 허용목록을 검증한다(정본 하나)', () => {
    expect(EMPLOYEE_ID_RE.test('hopegiver')).toBe(true)
    expect(EMPLOYEE_ID_RE.test('a"b')).toBe(false)
  })

  it('길이 상한(MAX_EMPLOYEE_ID_LENGTH=64) — 정확히 64자는 통과, 65자는 거부(usage-employee-identity-linking.md §5.3 L13)', () => {
    expect(MAX_EMPLOYEE_ID_LENGTH).toBe(64)
    const exactly64 = 'a'.repeat(64)
    const over64 = 'a'.repeat(65)
    expect(isPromSafeEmployeeId(exactly64)).toBe(true)
    expect(isPromSafeEmployeeId(over64)).toBe(false)
  })
})

describe('normalizeEmployeeIdInput — 관리자 편집 API 입력 정규화·검증(§5.3, PUT /api/admin/users/:id/employee-id)', () => {
  it('null은 연결 해제 의도로 그대로 통과한다', () => {
    expect(normalizeEmployeeIdInput(null)).toEqual({ value: null })
  })

  it('문자열이 아니면(undefined 등) 에러를 반환한다', () => {
    expect(normalizeEmployeeIdInput(undefined).error).toBeTruthy()
    expect(normalizeEmployeeIdInput(123).error).toBeTruthy()
  })

  it('공백만 있는(trim 결과 빈 문자열) 값은 "연결을 해제하려면 null을 보내세요" 에러를 낸다', () => {
    const result = normalizeEmployeeIdInput('   ')
    expect(result.value).toBeUndefined()
    expect(result.error).toMatch(/null/)
  })

  it('trim + 소문자화된 정상값을 반환한다', () => {
    expect(normalizeEmployeeIdInput('  HopeGiver  ')).toEqual({ value: 'hopegiver' })
  })

  it('형식 위반(허용목록 밖 문자)은 에러를 반환한다', () => {
    const result = normalizeEmployeeIdInput('a"b')
    expect(result.value).toBeUndefined()
    expect(result.error).toMatch(/\^\[a-z0-9/)
  })

  it('길이 상한(64자) 초과는 에러를 반환한다(§5.3 L13, 매처·PromQL로 흘러가지 않는다)', () => {
    const tooLong = 'a'.repeat(65)
    const result = normalizeEmployeeIdInput(tooLong)
    expect(result.value).toBeUndefined()
    expect(result.error).toMatch(/64/)
  })

  it('정확히 64자는 통과한다(경계값)', () => {
    const exactly64 = 'a'.repeat(64)
    expect(normalizeEmployeeIdInput(exactly64)).toEqual({ value: exactly64 })
  })
})

describe('employeeIdMatcher/escapeLabelValue — PromQL 라벨 매처 조립', () => {
  it('정상값은 그대로 매처 문자열이 된다', () => {
    expect(employeeIdMatcher('hopegiver')).toBe('employee_id="hopegiver"')
  })

  it('escapeLabelValue는 백슬래시·큰따옴표를 이스케이프한다(허용목록 통과 후에도 no-op이 아니라 항상 적용됨을 확인)', () => {
    expect(escapeLabelValue('a\\b"c')).toBe('a\\\\b\\"c')
  })
})

describe('resolveEmployeeScope — IDOR 회귀 테스트(§6.2 불변식 I1) — GET /api/usage/me 본인 스코프 판정', () => {
  it('employeeId 없으면(관리자 전사 조회, /summary·/users 기존 호출부) scoped:false + 완전 무필터', () => {
    expect(resolveEmployeeScope(undefined)).toEqual({ scoped: false, safe: false, employeeId: null, matchers: [] })
    expect(resolveEmployeeScope(null)).toEqual({ scoped: false, safe: false, employeeId: null, matchers: [] })
    expect(resolveEmployeeScope('')).toEqual({ scoped: false, safe: false, employeeId: null, matchers: [] })
  })

  it('안전한 employeeId는 scoped:true + safe:true + employee_id 라벨매처 1개를 만든다', () => {
    const scope = resolveEmployeeScope('hopegiver')
    expect(scope.scoped).toBe(true)
    expect(scope.safe).toBe(true)
    expect(scope.employeeId).toBe('hopegiver')
    expect(scope.matchers).toEqual(['employee_id="hopegiver"'])
  })

  // I1 핵심 회귀 테스트 — 이 테스트가 실패하면(matchers가 채워지거나 scoped가 false로 뒤집히면)
  // "안전하지 않은 employeeId"가 "무필터(전사)"로 오독될 수 있는 경로가 생긴 것이다. employeeId는
  // 보통 employeeIdFromEmail()을 거쳐 이미 안전하지만, resolveEmployeeScope는 그 사실에 기대지 않고
  // 독립적으로 재검증한다(defense in depth, §4.4) — 그래서 이 케이스는 인위적으로 안전하지 않은
  // employeeId를 직접 주입해 만든다.
  it('라벨 인젝션 위험 문자가 섞인 employeeId는 matchers를 비우되(라이브 질의 생략용) scoped는 true로 유지한다 — ' +
      '빈 matchers가 "무필터(전사)"로 오독되면 절대 안 되므로 scoped 플래그로 두 상태를 명확히 구분한다', () => {
    const scope = resolveEmployeeScope('a"{user_email=~".*"}')
    expect(scope.scoped).toBe(true)
    expect(scope.safe).toBe(false)
    expect(scope.matchers).toEqual([]) // 비어 있지만
    expect(scope.scoped).not.toBe(false) // scoped=false(무필터)로는 절대 뒤집히지 않는다
    // D1 캐시 스코핑(employeeId)은 라벨 안전성과 무관하게 항상 유효해야 한다(I2) — SQL 파라미터라
    // 인젝션이 불가능하므로, 안전하지 않은 문자열이라도 employeeId 필드 자체는 그대로 보존해
    // readHybridSnapshot()의 바인딩 파라미터로 넘길 수 있어야 한다(단지 0행이 반환될 뿐).
    expect(scope.employeeId).toBe('a"{user_email=~".*"}')
  })

  it('scoped=true인 두 경우(safe 여부와 무관) 모두 employeeId 필드가 항상 보존된다(I2 — D1 스코핑은 라벨 안전성과 무관하게 유효)', () => {
    const safeScope = resolveEmployeeScope('hopegiver')
    const unsafeScope = resolveEmployeeScope('bad value')
    expect(safeScope.employeeId).toBe('hopegiver')
    expect(unsafeScope.employeeId).toBe('bad value')
  })
})

describe('decodeEmployeeName — URL 인코딩된 한글 표시 이름 디코드(§4.3 값 정규화 6항)', () => {
  it('정상 URL 인코딩 값을 디코드한다', () => {
    expect(decodeEmployeeName('%ED%95%98%EA%B7%BC%ED%98%B8')).toBe('하근호')
  })

  it('깨진 퍼센트열이면 원본 그대로 반환한다(예외로 죽지 않는다)', () => {
    expect(decodeEmployeeName('%ED%95')).toBe('%ED%95')
  })

  it('인코딩되지 않은 일반 문자열은 그대로 반환한다', () => {
    expect(decodeEmployeeName('hopegiver')).toBe('hopegiver')
  })

  it('빈 값/비문자열은 예외 없이 통과한다', () => {
    expect(decodeEmployeeName('')).toBe('')
    expect(decodeEmployeeName(null)).toBeNull()
    expect(decodeEmployeeName(undefined)).toBeNull()
  })
})

describe('pickDisplayName — 표시 이름 단일 정본(§3.4, 사전순 최소로 통일)', () => {
  it('D1 users.name이 있으면 항상 최우선이다', () => {
    expect(pickDisplayName({ d1Name: '하근호', employeeNames: new Set(['다른이름']), employeeId: 'other' })).toBe('하근호')
  })

  it('D1 이름이 없으면 employeeNames 중 사전순 최소를 고른다(결정적 — 최초 관측 순서에 의존하지 않는다)', () => {
    expect(pickDisplayName({ d1Name: null, employeeNames: new Set(['홍길동', '가나다']), employeeId: 'x' })).toBe('가나다')
  })

  it('employeeNames도 없으면 employeeId로 폴백한다', () => {
    expect(pickDisplayName({ d1Name: null, employeeNames: new Set(), employeeId: 'hopegiver' })).toBe('hopegiver')
  })

  it('아무것도 없으면 null(unk: 행)', () => {
    expect(pickDisplayName({ d1Name: null, employeeNames: null, employeeId: null })).toBeNull()
  })

  it('employeeNames에 빈 문자열이 섞여 있어도 무시한다', () => {
    expect(pickDisplayName({ d1Name: null, employeeNames: new Set(['', '나나']), employeeId: 'x' })).toBe('나나')
  })
})

// docs/design/usage-shared-workstation-axes.md §4.1-3·S14 — 공용 워크스테이션 행의 표시 이름은
// **등록 라벨 > employee_id**이고, 관측 employee_name으로는 절대 폴백하지 않는다. 관측 이름을 주
// 이름으로 쓰면 이번 사고의 원인(관리자가 "김도형 개인 관측치"로 오해)이 그대로 되살아난다.
describe('pickSharedWorkstationName — 공용 축 표시 이름(관측 이름 폴백 금지)', () => {
  it('라벨이 있으면 라벨을 쓴다', () => {
    expect(pickSharedWorkstationName({ label: '3층 공용 PC', employeeId: 'claude' })).toBe('3층 공용 PC')
  })

  it('라벨이 없으면(null·빈 문자열·공백만) employee_id로 폴백한다 — 관측 이름은 애초에 인자로 받지 않는다', () => {
    expect(pickSharedWorkstationName({ label: null, employeeId: 'claude' })).toBe('claude')
    expect(pickSharedWorkstationName({ label: '', employeeId: 'claude' })).toBe('claude')
    expect(pickSharedWorkstationName({ label: '   ', employeeId: 'claude' })).toBe('claude')
  })

  it('라벨 앞뒤 공백은 다듬는다', () => {
    expect(pickSharedWorkstationName({ label: '  2층 공용  ', employeeId: 'malgn' })).toBe('2층 공용')
  })

  it('둘 다 없으면 null', () => {
    expect(pickSharedWorkstationName({ label: null, employeeId: null })).toBeNull()
  })
})
