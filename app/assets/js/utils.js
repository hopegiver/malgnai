/**
 * utils.js — 전역 유틸 함수 모음 (malgnai-hub)
 * index.html에서 <script src="/assets/js/utils.js"> 로 로드.
 * .vue 파일에서 import 없이 바로 사용(vue-zero Blob URL 패턴 — composables 금지, 공유 로직은
 * 전부 이 파일의 전역 함수로 등록해 window.* 처럼 어디서나 호출). API 계약은 docs/api.md 정본.
 */

/**
 * useApi — 범용 API fetch 헬퍼
 *
 * GET:
 *   const { data, error } = await useApi('/api/projects')
 *   if (error) { this.error = error; return }
 *   this.projects = data.data
 *
 * POST:
 *   const { data, error } = await useApi('/api/devices/pair-approve', {
 *     method: 'POST',
 *     body: { pairing_code: code },
 *   })
 *
 * 인증 토큰은 localStorage.token 이 있으면 자동으로 Authorization 헤더에 추가됩니다.
 * 에러 응답 계약(docs/api.md): { error: { code: 'SNAKE_CASE_CODE', message, details? } } —
 * 이 함수는 실패 시 그 { code, message, details } 객체(또는 파싱 불가 시 문자열)를 error로 반환한다.
 */
async function useApi(url, options = {}) {
  const { method = 'GET', body, _retried = false } = options

  const headers = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem('token')
  if (token) headers['Authorization'] = `Bearer ${token}`

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      // 401: 토큰 만료/무효. 로그인/리프레시 요청 자체는 제외하고, refresh_token으로
      // 한 번만 access token 갱신을 시도한 뒤 원래 요청을 재시도한다. 실패하면 로그아웃.
      if (res.status === 401 && !url.endsWith('/api/auth/login') && !url.endsWith('/api/auth/refresh')) {
        if (!_retried) {
          const refreshed = await refreshAccessToken()
          if (refreshed) {
            return useApi(url, { ...options, _retried: true })
          }
        }
        logout()
      }
      return { data: null, error: data?.error ?? data?.message ?? `HTTP ${res.status}` }
    }
    return { data, error: null }
  } catch {
    return { data: null, error: { code: 'NETWORK_ERROR', message: '네트워크 오류가 발생했습니다.' } }
  }
}

/**
 * refreshAccessToken — localStorage.refresh_token으로 새 access+refresh 쌍을 발급받는다.
 * useApi()를 쓰면 401 처리 로직과 순환참조 위험이 있어 raw fetch를 직접 사용.
 * refresh_token은 서버가 사용 즉시 폐기하는 회전(rotation) 방식이라(docs/api.md §5.1
 * TOKEN_REUSED), 응답으로 받은 새 refresh_token으로 반드시 교체 저장한다.
 * 성공: localStorage.token/refresh_token 갱신 후 true. 실패: 둘 다 지우고 false.
 *
 * [in-flight dedup] index.html 부트 시 사전갱신, default.vue 주기 타이머, useApi()의 401 재시도가
 * 거의 동시에 만료를 감지하면 각자 refresh를 호출해 같은 refresh_token으로 경쟁하게 된다 —
 * 회전형이라 먼저 도착한 요청만 성공하고 나머지는 401로 불필요하게 로그아웃될 위험이 있다.
 * 진행 중인 refresh가 있으면 그 Promise를 공유해 실제 네트워크 호출은 항상 최대 1개만 나가게 한다.
 */
let _refreshInFlight = null

async function refreshAccessToken() {
  if (_refreshInFlight) return _refreshInFlight

  _refreshInFlight = (async () => {
    const refreshToken = localStorage.getItem('refresh_token')
    if (!refreshToken) return false

    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      if (!res.ok) {
        localStorage.removeItem('token')
        localStorage.removeItem('refresh_token')
        return false
      }
      const data = await res.json().catch(() => null)
      if (!data?.token) {
        localStorage.removeItem('token')
        localStorage.removeItem('refresh_token')
        return false
      }
      localStorage.setItem('token', data.token)
      if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token)
      return true
    } catch {
      localStorage.removeItem('token')
      localStorage.removeItem('refresh_token')
      return false
    }
  })()

  try {
    return await _refreshInFlight
  } finally {
    _refreshInFlight = null
  }
}

/**
 * 로그아웃 — docs/api.md §5.1에는 login/refresh/me 3개뿐 별도 서버측 로그아웃(revoke) 라우트가
 * 없으므로 로컬 토큰만 지우고 /login으로 이동한다(서버 호출 없음). refresh_token은 회전형이라
 * 다음 사용 시도가 있으면 TOKEN_REUSED로 자연히 막히고, 그렇지 않으면 만료(30일)로 정리된다.
 */
function logout() {
  localStorage.removeItem('token')
  localStorage.removeItem('refresh_token')
  _currentUser = null
  _currentUserPromise = null
  const path = window.location.pathname + window.location.search
  if (window.location.pathname !== '/login') {
    const q = path && path !== '/' ? `?redirect=${encodeURIComponent(path)}` : ''
    window.location.href = `/login${q}`
  }
}

/**
 * decodeJwtPayload — JWT의 payload 세그먼트를 디코드한다.
 * JWT는 RFC 7519상 base64url(문자 62/63번이 '-'/'_', 패딩 '=' 없음)로 인코딩되는데, 표준
 * atob()는 base64(+, /)만 받아들여 '-'/'_'가 포함된 payload(한글 이름 등 UTF-8 바이트가
 * 섞이면 흔히 발생)에서 예외를 던진다 — 실제로 이 프로젝트의 JWT는 backend가 `jose`로
 * 발급하므로(package.json 의존성) 이 케이스가 실사용에서 재현된다. 반드시 이 헬퍼를 거쳐서만
 * 디코드한다(atob 직접 호출 금지).
 */
function decodeJwtPayload(token) {
  const seg = token.split('.')[1]
  if (!seg) return null
  let b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  return JSON.parse(atob(b64))
}

/** 현재 로그인 토큰의 payload 디코드(만료/형식오류면 null). JWT 클레임 상세는 서버 구현에 달려있어
 * exp만 신뢰하고 그 외 필드(이름 등 표시용)는 getCurrentUser()(GET /api/auth/me)로 따로 조회한다. */
function tokenPayload() {
  try {
    const t = localStorage.getItem('token')
    if (!t) return null
    const p = decodeJwtPayload(t)
    if (!p || (p.exp && p.exp * 1000 <= Date.now())) return null
    return p
  } catch {
    return null
  }
}

/**
 * getCurrentUser — GET /api/auth/me 캐시 래퍼. 레이아웃(default.vue)이 사용자명 표시를 위해
 * 마운트마다 호출해도 실제 네트워크 요청은 세션당 1번만 나가도록 in-memory 캐시 + in-flight dedup.
 * 로그인/로그아웃 시 반드시 무효화해야 하므로 logout()에서 직접 초기화한다.
 */
let _currentUser = null
let _currentUserPromise = null

async function getCurrentUser(force = false) {
  if (force) {
    _currentUser = null
    _currentUserPromise = null
  }
  if (_currentUser) return _currentUser
  if (_currentUserPromise) return _currentUserPromise

  _currentUserPromise = (async () => {
    const { data, error } = await useApi('/api/auth/me')
    _currentUserPromise = null
    if (error || !data) return null
    // 응답 봉투 형태가 { data: {...} } 인지 최상위 사용자 객체인지 불확실해 둘 다 수용.
    _currentUser = data.data ?? data.user ?? data
    return _currentUser
  })()
  return _currentUserPromise
}

/** ISO 문자열 → 'YYYY-MM-DD HH:mm' (로컬 타임존). 파싱 실패/빈 값은 '-'. */
function formatDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** ISO 문자열 → 상대 시간(방금 전/N분 전/N시간 전/N일 전). 7일 이상은 절대 날짜로 표시. */
function formatRelative(iso) {
  if (!iso) return '-'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '-'
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '방금 전'
  if (min < 60) return `${min}분 전`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}시간 전`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}일 전`
  return formatDate(iso).slice(0, 10)
}

/**
 * 도메인 enum → 배지 메타 매핑. base.css가 이미 시맨틱 컬러(success/warning/danger/info,
 * WCAG AA 대비 검증됨, base.css:76~97 주석 참고)와 .badge.bg-* 클래스를 정의하고 있어
 * 신규 팔레트 없이 기존 토큰에 각 테이블의 enum(schema.sql)을 그대로 매핑한다.
 */

/** projects.status(schema.sql §3.3): active/archived. */
function projectStatusMeta(status) {
  const M = {
    active: { label: '진행', cls: 'bg-primary' },
    archived: { label: '보관', cls: 'bg-secondary' },
  }
  return M[status] || { label: status || '-', cls: 'bg-secondary' }
}

/** issues.severity(schema.sql §3.5): low/medium/high/critical. */
function issueSeverityMeta(severity) {
  const M = {
    low: { label: '낮음', cls: 'bg-secondary' },
    medium: { label: '보통', cls: 'bg-info' },
    high: { label: '높음', cls: 'bg-warning' },
    critical: { label: '심각', cls: 'bg-danger' },
  }
  return M[severity] || { label: severity || '-', cls: 'bg-secondary' }
}

/** issues.status(schema.sql §3.5): open/resolved. */
function issueStatusMeta(status) {
  return status === 'resolved'
    ? { label: '해결', cls: 'bg-success' }
    : { label: '열림', cls: 'bg-danger' }
}

/** decisions.importance(schema.sql §3.4, 1~5). 4 이상은 영구보존 대상(architecture.md §10)과
 * 맞춰 danger로 강조한다. */
function decisionImportanceMeta(importance) {
  const n = Number(importance) || 0
  if (n >= 4) return { label: `중요 ${n}`, cls: 'bg-danger' }
  if (n === 3) return { label: `보통 ${n}`, cls: 'bg-info' }
  return { label: `낮음 ${n}`, cls: 'bg-secondary' }
}

/** WBS 계산된 bucket(mcp-tools.md §4.7): planned/in_progress/done/delayed.
 * delayed는 저장 컬럼이 아니라 조회 시점 파생값이므로 그대로 문자열을 받아 매핑만 한다. */
function wbsStatusMeta(bucket) {
  const M = {
    planned: { label: '계획', cls: 'bg-secondary' },
    in_progress: { label: '진행중', cls: 'bg-primary' },
    done: { label: '완료', cls: 'bg-success' },
    delayed: { label: '지연', cls: 'bg-danger' },
  }
  return M[bucket] || { label: bucket || '-', cls: 'bg-secondary' }
}

/** device_pairings.status(schema.sql §3.9): pending/approved/expired. */
function pairingStatusMeta(status) {
  const M = {
    pending: { label: '대기', cls: 'bg-info' },
    approved: { label: '승인됨', cls: 'bg-success' },
    expired: { label: '만료', cls: 'bg-secondary' },
  }
  return M[status] || { label: status || '-', cls: 'bg-secondary' }
}

/** 큰 수를 1.2M / 980K 식으로 축약(토큰 사용량 등). */
function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

/** links_json/artifacts 같은 문자열 JSON 배열 필드 파싱. 실패/빈 값/비배열은 []. 이미 배열이면 그대로. */
function parseJsonArray(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** users.role(schema.sql §3.1): employee/administrator. */
function userRoleMeta(role) {
  const M = {
    employee: { label: '직원', cls: 'bg-secondary' },
    administrator: { label: '관리자', cls: 'bg-primary' },
  }
  return M[role] || { label: role || '-', cls: 'bg-secondary' }
}

/** users.status(schema.sql §3.1): active/disabled. */
function userStatusMeta(status) {
  return status === 'disabled'
    ? { label: '비활성', cls: 'bg-secondary' }
    : { label: '활성', cls: 'bg-success' }
}

/** device_tokens.status(schema.sql §3.8): active/revoked. */
function deviceStatusMeta(status) {
  return status === 'revoked'
    ? { label: '폐기됨', cls: 'bg-secondary' }
    : { label: '활성', cls: 'bg-success' }
}

/**
 * 문자열 콘텐츠를 파일로 즉시 다운로드시킨다(Blob URL 패턴 — 트리거 즉시 해제해 누수 방지).
 * @param {string} filename
 * @param {string} content
 * @param {string} mime
 */
function downloadTextFile(filename, content, mime = 'application/json') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * 클립보드 복사. Clipboard API 우선, 실패(권한 거부/비보안 컨텍스트) 시 textarea+execCommand로 폴백.
 * @param {string} text
 * @returns {Promise<boolean>} 성공 여부
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      return true
    } catch {
      return false
    }
  }
}
