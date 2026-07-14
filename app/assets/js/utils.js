/**
 * utils.js — 전역 유틸 함수 모음
 * index.html에서 <script src="/assets/js/utils.js"> 로 로드.
 * .vue 파일에서 import 없이 바로 사용.
 */

/**
 * useApi — 범용 API fetch 헬퍼
 *
 * GET:
 *   const { data, error } = await useApi('/api/users')
 *   if (error) { this.error = error; return }
 *   this.users = data.users
 *
 * POST:
 *   const { data, error } = await useApi('/api/posts', {
 *     method: 'POST',
 *     body: { title: '제목', content: '내용' },
 *   })
 *
 * 인증 토큰은 localStorage.token 이 있으면 자동으로 Authorization 헤더에 추가됩니다.
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
    return { data: null, error: '네트워크 오류가 발생했습니다.' }
  }
}

/**
 * refreshAccessToken — localStorage.refresh_token으로 새 access+refresh 쌍을 발급받는다.
 * useApi()를 쓰면 401 처리 로직과 순환참조 위험이 있어 raw fetch를 직접 사용.
 * refresh_token은 서버가 사용 즉시 폐기하는 회전(rotation) 방식이라, 응답으로 받은
 * 새 refresh_token으로 반드시 교체 저장한다(이전 값 재사용 시 다음 갱신은 401).
 * 성공: localStorage.token/refresh_token 갱신 후 true. 실패: 둘 다 지우고 false.
 *
 * [in-flight dedup] index.html 부트 시 사전갱신, default.vue 5분 주기 타이머, useApi()의
 * 401 재시도가 거의 동시에 만료를 감지하면(예: PWA를 오래 후에 재오픈) 각자 refresh를
 * 호출해 같은 refresh_token으로 경쟁하게 된다 — 회전형이라 먼저 도착한 요청만 성공하고
 * 나머지는 401(invalid_refresh_token)로 불필요하게 로그아웃될 위험이 있다. 진행 중인
 * refresh가 있으면 새 요청을 만들지 않고 그 Promise를 공유해 실제 네트워크 호출은
 * 항상 최대 1개만 나가게 한다.
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
 * 인증이 필요한 파일 다운로드. localStorage.token 을 Authorization 헤더에 실어
 * fetch → blob → 프로그램matic 클릭으로 저장한다.
 *
 * <a href download> 직접 링크는 브라우저 네비게이션이라 Authorization 헤더가 실리지
 * 않는다. Cloudflare 터널 경유 시 /api/* 는 JWT 필수라 헤더 없는 요청이 401 JSON 을
 * 반환하고, download 속성 때문에 그 JSON 이 파일로 저장되는 문제가 있었다.
 * 반환: { ok: true } | { ok: false, error }
 */
async function downloadFileAuth(url, filename) {
  const headers = {}
  const token = localStorage.getItem('token')
  if (token) headers['Authorization'] = `Bearer ${token}`
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) {
      if (res.status === 401) logout()
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = filename || 'download'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objUrl)
    return { ok: true }
  } catch {
    return { ok: false, error: '네트워크 오류가 발생했습니다.' }
  }
}

/** 큰 수를 1.2M / 980K 식으로 축약(토큰·메시지 등). */
function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

/**
 * renderMarkdown — 의존성 없는 경량 마크다운 → HTML 변환.
 * STATUS.md 등 신뢰 가능한 로컬 파일을 카드에 보기 좋게 표시하는 용도.
 * HTML 을 먼저 이스케이프하므로 v-html 로 안전하게 출력 가능.
 * 지원: 코드펜스, 헤딩(#~######), 구분선(---), 인용(>), 순서/비순서 리스트,
 *       인라인 코드/볼드/이탤릭/링크.
 */
function renderMarkdown(md) {
  if (!md) return ''
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')

  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let listType = null // 'ul' | 'ol' | null
  let inCode = false
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      closeList()
      if (inCode) { out.push('</code></pre>'); inCode = false }
      else { out.push('<pre class="md-code"><code>'); inCode = true }
      continue
    }
    if (inCode) { out.push(esc(raw)); continue }

    const line = raw.trimEnd()
    if (!line.trim()) { closeList(); continue }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { closeList(); const lv = h[1].length; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push('<hr>'); continue }
    const q = line.match(/^>\s?(.*)$/)
    if (q) { closeList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); continue }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ul) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul' } out.push(`<li>${inline(ul[1])}</li>`); continue }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ol) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol' } out.push(`<li>${inline(ol[1])}</li>`); continue }

    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  if (inCode) out.push('</code></pre>')
  return out.join('\n')
}

/**
 * activityCategoryMeta — 활동 category(§2.3 8종) → 배지 표시 메타.
 * 반환 { label, icon, fg, bg } (앱 공통 soft 배지 스타일: 연한 배경 + 짙은 글자).
 * 미지정/미등록 category 는 null 반환(호출부에서 '-' 표시 → 백필 전 category=NULL 안전).
 */
function activityCategoryMeta(category) {
  const M = {
    plan:     { label: '기획',   icon: 'bi-lightbulb',       fg: '#5b4bd6', bg: 'rgba(91,75,214,0.12)' },
    design:   { label: '설계',   icon: 'bi-easel',           fg: '#0075de', bg: 'rgba(0,117,222,0.10)' },
    build:    { label: '구현',   icon: 'bi-hammer',          fg: '#157a29', bg: 'rgba(26,174,57,0.12)' },
    verify:   { label: '검증',   icon: 'bi-clipboard-check', fg: '#b5540a', bg: 'rgba(221,91,0,0.12)' },
    decision: { label: '결정',   icon: 'bi-flag-fill',       fg: '#7a3ff2', bg: 'rgba(122,63,242,0.12)' },
    deploy:   { label: '배포',   icon: 'bi-rocket-takeoff',  fg: '#1f7d79', bg: 'rgba(42,157,153,0.14)' },
    ops:      { label: '운영',   icon: 'bi-gear-fill',       fg: '#5c636a', bg: 'rgba(108,117,125,0.14)' },
    system:   { label: '시스템', icon: 'bi-cpu',             fg: '#7a828a', bg: 'rgba(173,181,189,0.20)' },
  }
  return M[category] || null
}

/**
 * activityResultMeta — 활동 result → 배지 { label, cls }.
 * success/failed/partial/skipped/pending. NULL·미지정(정보성 로그)은 null 반환.
 * cls 는 앱 공통 배지 클래스(base.css .badge.bg-*)를 재사용.
 */
function activityResultMeta(result) {
  const M = {
    success: { label: '성공',   cls: 'bg-success' },
    failed:  { label: '실패',   cls: 'bg-danger' },
    partial: { label: '부분',   cls: 'bg-warning' },
    skipped: { label: '건너뜀', cls: 'bg-secondary' },
    pending: { label: '대기',   cls: 'bg-info' },
  }
  return M[result] || null
}

/** links_json(문자열 JSON 배열) → 링크 배열. 실패/빈 값/비배열은 []. 이미 배열이면 그대로. */
function parseActivityLinks(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 현재 로그인 토큰의 payload 디코드(만료/형식오류면 null). { sub, role, exp ... } */
function tokenPayload() {
  try {
    const t = localStorage.getItem('token')
    if (!t) return null
    const p = JSON.parse(atob(t.split('.')[1]))
    if (p.exp && p.exp * 1000 <= Date.now()) return null
    return p
  } catch {
    return null
  }
}

/** 현재 로그인 사용자가 최고관리자(role==='super_admin')인지. admin/user는 권한상 동일(라벨만 다름) — UI 가드는 이 이진 판단 하나만 쓴다. */
function isSuperAdmin() {
  return tokenPayload()?.role === 'super_admin'
}

/** 현재 로그인 사용자가 staff(super_admin 또는 admin)인지. user(일반)만 false. */
function isStaff() {
  const role = tokenPayload()?.role
  return role === 'super_admin' || role === 'admin'
}

/**
 * 토큰 삭제 후 로그인 페이지로 이동(현재 경로를 redirect 로 보존).
 * refresh_token이 있으면 서버에 revoke를 fire-and-forget으로 알린다(응답을 기다리지 않음 —
 * 사용자를 로그아웃 흐름에서 지연시키지 않기 위함, 실패해도 무시).
 */
function logout() {
  const refreshToken = localStorage.getItem('refresh_token')
  if (refreshToken) {
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }).catch(() => {})
  }
  localStorage.removeItem('token')
  localStorage.removeItem('refresh_token')
  const path = window.location.pathname + window.location.search
  if (window.location.pathname !== '/login') {
    const q = path && path !== '/' ? `?redirect=${encodeURIComponent(path)}` : ''
    window.location.href = `/login${q}`
  }
}
