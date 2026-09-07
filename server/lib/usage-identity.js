// 식별 축 순수 함수 — HTTP·D1·네트워크를 모른다(설계 §3 모듈 경계 원칙). 단위테스트 대상.
// 설계 정본: docs/design/usage-employee-identity.md §3.4.
//
// server/lib/usage-prom.js(PromQL 조립·병합)와 server/api/usage.js(라우트)가 이 파일의 함수만
// 가져다 쓴다 — 반대 방향 의존(이 파일이 usage-prom.js/D1 DAO를 import)은 만들지 않는다.

// 허용목록(allowlist) — PromQL 메타문자(" \ { } 공백 ,)를 원천 배제한다. employee_id는 항상
// users.email의 '@' 앞부분(로컬파트)이라 문자 집합이 좁고, 허용목록은 "새 메타문자가 생겨도
// 자동으로 막힌다"는 장점이 있다(기존 이메일 검증의 부정형 문자클래스보다 강한 형태, §4.4).
export const EMPLOYEE_ID_RE = /^[a-z0-9._%+-]+$/

// usage-employee-identity-linking.md §5.3 — 관리자 편집 API의 길이 상한. 정규식만으로는 길이가
// 무한이라, 매처에 들어가는 마지막 방어선(isPromSafeEmployeeId)이 길이를 보지 않는 상태를 남기지
// 않기 위해 여기서도 재사용한다(정본 하나).
export const MAX_EMPLOYEE_ID_LENGTH = 64

/** D1 users.email → employee_id. 형식 이상·'@' 없음·허용목록 밖이면 null.
 *  ⚠️ usage-employee-identity-linking.md §3.1·§3.2 — 이 함수는 더 이상 읽기 경로(=/api/usage/me·
 *  관리자 목록 병합)에서 호출하지 않는다. 읽기 정본은 오직 D1 users.employee_id 컬럼이다(폴백 없음).
 *  이 함수는 **쓰기 시점 파생 전용**으로 용도가 좁혀졌다 — 마이그레이션 백필(SQL로 별도 구현),
 *  `POST /api/admin/users`의 기본값 계산(§5.8), 관리자 편집 UI의 제안값 계산(§7.3-A)에서만 쓴다. */
export function employeeIdFromEmail(email) {
  if (typeof email !== 'string') return null
  const at = email.indexOf('@')
  if (at <= 0) return null // '@' 없음 또는 로컬파트가 빈 문자열
  const localPart = email.slice(0, at).toLowerCase()
  return EMPLOYEE_ID_RE.test(localPart) ? localPart : null
}

/** 라벨 매처 삽입 안전성 — employeeIdFromEmail의 출력이 아니라 "매처에 넣기 직전"에 다시 본다
 *  (defense in depth, §4.4). employeeIdFromEmail을 거친 값은 이미 이 검사를 통과하지만, 그 사실에
 *  기대어 이 검사를 생략하는 코드 경로를 만들지 않는다 — I1 불변식의 실제 방어선은 이 함수다.
 *  길이 상한(§5.3)도 여기서 함께 본다 — DB에 저장된 값(관리자가 입력한 문자열)이 매처에 들어가는
 *  마지막 방어선이라 형식뿐 아니라 길이도 이 함수 하나가 최종 판정한다. */
export function isPromSafeEmployeeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_EMPLOYEE_ID_LENGTH && EMPLOYEE_ID_RE.test(id)
}

/** 관리자 편집 API(PUT /api/admin/users/:id/employee-id) 입력 정규화 + 검증(§5.3, 4계층 중
 *  "정규화"·"형식" 두 단계를 이 함수 하나로 수행). 반환:
 *   - raw === null → { value: null }(연결 해제 의도, 정상)
 *   - raw가 문자열이 아니면 → { error: 'employee_id must be a string or null' }
 *   - trim 후 빈 문자열이면 → { error: '연결을 해제하려면 null을 보내세요' }
 *   - 형식/길이 위반 → { error: 'employee_id must match ^[a-z0-9._%+-]+$ and be at most 64 characters' }
 *   - 정상 → { value: '<trim+lowercase>' }
 *  라우트는 이 함수 하나만 호출하면 §5.3 표의 "라우트→정규화→형식" 3단계가 전부 끝난다. */
export function normalizeEmployeeIdInput(raw) {
  if (raw === null) return { value: null }
  if (typeof raw !== 'string') return { error: 'employee_id must be a string or null' }
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return { error: '연결을 해제하려면 null을 보내세요' }
  if (!isPromSafeEmployeeId(trimmed)) {
    return { error: `employee_id must match ^[a-z0-9._%+-]+$ and be at most ${MAX_EMPLOYEE_ID_LENGTH} characters` }
  }
  return { value: trimmed }
}

// PromQL 라벨 매처 문자열 조립(user_email 매처와 동일한 이스케이프 규칙 재사용, usage-prom.js가
// import해서 emailMatcher에도 그대로 쓴다 — 이스케이프 로직을 두 곳에 복제하지 않는다).
export function escapeLabelValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function employeeIdMatcher(employeeId) {
  return `employee_id="${escapeLabelValue(employeeId)}"`
}

/** 본인/드릴다운 스코프 판정 — resolveEmailScope(usage-prom.js)의 employee_id 판(§6.1).
 *  scoped=false → 무필터(관리자 전사, employeeId 생략 호출).
 *  scoped=true & safe=false → matchers: [] 다만 scoped는 유지 — 호출부가 이 경우 라이브 질의
 *  자체를 생략해야 한다(§6.2 I1 불변식, "빈 matchers=전체 조회"로 뒤집히면 안 된다). */
export function resolveEmployeeScope(employeeId) {
  const scoped = typeof employeeId === 'string' && employeeId.length > 0
  if (!scoped) return { scoped: false, safe: false, employeeId: null, matchers: [] }
  const safe = isPromSafeEmployeeId(employeeId)
  return { scoped: true, safe, employeeId, matchers: safe ? [employeeIdMatcher(employeeId)] : [] }
}

/** employee_name 라벨(URL 인코딩 한글, 예: %ED%95%98%EA%B7%BC%ED%98%B8) 디코드. 깨진 퍼센트열이면
 *  원본 그대로 반환한다(§4.3 값 정규화 6항). 빈 값/비문자열은 그대로 통과(호출부가 null 등을 그대로
 *  넘겨도 예외가 나지 않게). */
export function decodeEmployeeName(raw) {
  if (typeof raw !== 'string' || raw === '') return raw ?? null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 표시 이름 우선순위 단일 정본(§3.4) — D1 users.name > 디코드된 employee_name(사전순 최소) >
 *  employee_id > null. 정본 문서의 두 불일치(§4.1 "최초 관측값" vs §17.5 MAX)를 이 규칙 하나로
 *  해소한다 — 요청마다 흔들리지 않는 결정적 규칙(사전순 최소)이면 충분하고, 최초 관측 순서는
 *  병합 순서에 의존해 결정적이지 않다.
 *  employeeNames: Iterable<string>(이미 decodeEmployeeName을 거친 값들). */
export function pickDisplayName({ d1Name, employeeNames, employeeId }) {
  if (d1Name) return d1Name
  const names = employeeNames ? [...employeeNames].filter((n) => typeof n === 'string' && n.length > 0).sort() : []
  if (names.length) return names[0]
  return employeeId || null
}
