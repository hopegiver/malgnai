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

/** catalog_items.item_type(schema.sql §3.17): agent/skill/knowledge. */
function catalogItemTypeMeta(itemType) {
  const M = {
    agent: { label: '에이전트', cls: 'bg-primary', icon: 'bi-robot' },
    skill: { label: '스킬', cls: 'bg-info', icon: 'bi-lightning-charge' },
    knowledge: { label: '지식', cls: 'bg-secondary', icon: 'bi-book' },
  }
  return M[itemType] || { label: itemType || '-', cls: 'bg-secondary', icon: 'bi-question-circle' }
}

/** catalog_promotions.status(schema.sql §3.17): draft/review/promoted/deprecated.
 * v1엔 승격 파이프라인이 아직 없어 값이 없는(null) 경우가 대부분 — 그 경우 "평가 전"으로 표시. */
function catalogPromotionStatusMeta(status) {
  const M = {
    draft: { label: '초안', cls: 'bg-secondary' },
    review: { label: '검토중', cls: 'bg-warning' },
    promoted: { label: '승격됨', cls: 'bg-success' },
    deprecated: { label: '폐기됨', cls: 'bg-danger' },
  }
  return M[status] || { label: '평가 전', cls: 'bg-light text-dark' }
}

/**
 * 카탈로그 조직도화 — 카테고리 정적 lookup (docs/ux/catalog-information-architecture.md §4~5 정본).
 * schema.sql의 catalog_items에는 category 컬럼이 없어(마이그레이션 불필요, IA 문서 §확인 완료)
 * DB 변경 없이 프론트 정적 매핑으로만 그룹핑한다. 3개 탭(agent/skill/knowledge)은 서로 다른 신뢰
 * 가능한 원천 데이터를 쓴다: agent는 slug 확정 매핑(IA §4, 21개 전수 조사), skill은 slug 접두사
 * (IA §2.2 — 접두사 없는 24개까지 8분류로 재태깅하는 건 이번 범위 밖, 추측 금지), knowledge는
 * source_path의 폴더 세그먼트(이미 있는 데이터, 태깅 불필요).
 */

/** agent 카테고리 표시 순서(IA §4 — "위임 흐름" 순서 그대로 조직도 의미를 갖게 배치). '기타'는
 * lookup에 없는 신규 agent용 폴백 섹션으로 항상 맨 끝에 고정한다(IA §7 — 사라짐 방지). */
const CATALOG_AGENT_CATEGORY_ORDER = ['총괄', '리서치·기획', '설계', '개발·구축', '품질·검증', '제안·사업성', '콘텐츠·커뮤니케이션', '조직 학습·평가', '기타']

/** agents.slug → 카테고리(IA §4 표, 21개 확정 매핑 그대로). */
const CATALOG_AGENT_CATEGORY_MAP = {
  pm: '총괄',
  researcher: '리서치·기획',
  planner: '리서치·기획',
  architect: '설계',
  'ux-designer': '설계',
  'visual-designer': '설계',
  'backend-dev': '개발·구축',
  'frontend-dev': '개발·구축',
  devops: '개발·구축',
  'qa-engineer': '품질·검증',
  security: '품질·검증',
  reviewer: '품질·검증',
  'capture-strategist': '제안·사업성',
  'rfp-analyst': '제안·사업성',
  finance: '제안·사업성',
  writer: '콘텐츠·커뮤니케이션',
  presenter: '콘텐츠·커뮤니케이션',
  marketer: '콘텐츠·커뮤니케이션',
  localizer: '콘텐츠·커뮤니케이션',
  trainer: '조직 학습·평가',
  evaluator: '조직 학습·평가',
}

/** agent slug → 카테고리 라벨. lookup에 없으면(신규 agent 동기화 지연) '기타'로 폴백. */
function catalogAgentCategory(slug) {
  return CATALOG_AGENT_CATEGORY_MAP[slug] || '기타'
}

/** skill 카테고리 표시 순서. IA §2.2: 접두사 없는 24개까지 8분류로 확정 태깅하진 않았으므로
 * 이 이상 세분화하지 않는다(추측 금지) — slug 접두사 3종 + 기타로만 단순 그룹핑. */
const CATALOG_SKILL_CATEGORY_ORDER = ['공통', '도메인', '주제학습', '기타']

/** skill slug 접두사 → 카테고리 라벨. common-/domain-/topic- 3종 접두사만 신뢰하고, 그 외
 * (접두사 없는 24개 포함)는 전부 '기타'로 묶는다(IA §2.2 결론). */
function catalogSkillCategory(slug) {
  if (!slug) return '기타'
  if (slug.startsWith('common-')) return '공통'
  if (slug.startsWith('domain-')) return '도메인'
  if (slug.startsWith('topic-')) return '주제학습'
  return '기타'
}

/** knowledge slug(예: 'backend/api-implementation-patterns')의 폴더 세그먼트를 추출한다.
 * 주의: source_path(schema.sql, 'malgn-dev/knowledge/backend/....md')는 상세 조회
 * (GET /api/catalog/:id) 응답에만 있고, 목록 조회(GET /api/catalog) 응답에는 내려오지 않는다
 * (server/api/catalog.js 목록 직렬화 확인, 2026-08-06) — 실측 없이 IA 문서의 source_path 가정을
 * 그대로 구현했다면 전량 '기타'로 깨졌을 것(실측 결과 실제로 재현됨). 대신 목록 응답에 이미 있는
 * slug가 'folder/name' 형식으로 동일한 폴더 정보를 담고 있어 이걸 쓴다. slug에 '/'가 없으면(예:
 * 'README', 카테고리 아님) '기타'로 폴백. */
function catalogKnowledgeCategory(slug) {
  if (!slug) return '기타'
  const idx = slug.indexOf('/')
  if (idx <= 0) return '기타'
  return slug.slice(0, idx)
}

/**
 * 신뢰 소스(회사 GitHub 플러그인 repo의 content_md, work_record 자유서술 텍스트 등)를 안전한
 * HTML로 변환한다. marked로 파싱 후 DOMPurify로 살균 — v-html 주입 전 항상 이 함수를 거친다(raw
 * marked.parse() 직접 v-html 금지). marked/DOMPurify는 index.html에서 CDN으로 로드(전역
 * marked/DOMPurify 사용, 카탈로그 상세 전용 아님 — 프로젝트 상세 등 v-html 렌더 화면 전반에서 공용).
 * @param {string} md
 * @param {object} [opts] - marked.parse()로 그대로 전달되는 옵션(예: { breaks: true }로 단일
 *   개행도 <br> 처리). 기존 호출부(카탈로그 상세)는 인자를 넘기지 않으므로 기본값 {}으로 하위호환 유지.
 */
function renderMarkdown(md, opts = {}) {
  if (!md) return ''
  try {
    // agent/skill 원본 md 최상단의 YAML frontmatter(--- name/description ... ---)는
    // 카탈로그 화면에 이미 display_name/description으로 표시되므로 본문 렌더링에서는 제거한다.
    const stripped = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    return DOMPurify.sanitize(marked.parse(stripped, opts))
  } catch {
    return '<p class="text-danger">마크다운 렌더링에 실패했습니다.</p>'
  }
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
