<template>
  <div class="login-wrap d-flex min-vh-100">
    <!-- 좌: 브랜드 패널 (lg 이상) -->
    <div class="login-brand d-none d-lg-flex flex-column justify-content-between p-5">
      <div class="d-flex align-items-center gap-2">
        <span class="login-brand-mark d-inline-flex align-items-center justify-content-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M7 8h10M7 12h10M7 16h6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </span>
        <span class="fw-bold fs-5 text-white">malgnai-hub</span>
      </div>
      <div>
        <h1 class="text-white fw-bold mb-3" style="font-size:1.9rem; line-height:1.25; letter-spacing:-0.03rem;">
          맑은소프트 공통<br>프로젝트 메모리
        </h1>
        <p class="mb-0" style="color:rgba(255,255,255,0.78); font-size:0.95rem;">
          프로젝트별 작업이력·결정·이슈·상태를 조회하고, 세션/토큰 사용량을 확인하세요.
        </p>
      </div>
      <p class="mb-0" style="color:rgba(255,255,255,0.55); font-size:0.8125rem;">© 맑은소프트 · malgnai-hub</p>
    </div>

    <!-- 우: 폼 -->
    <div class="login-form-col d-flex align-items-center justify-content-center flex-grow-1 px-3 py-5 bg-canvas-soft">
    <div class="login-card bg-canvas border border-hairline p-4 p-sm-5">
      <div class="d-flex align-items-center gap-2 mb-3 d-lg-none">
        <span class="login-brand-mark login-brand-mark--sm d-inline-flex align-items-center justify-content-center">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M7 8h10M7 12h10M7 16h6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </span>
        <span class="fw-bold fs-6">malgnai-hub</span>
      </div>
      <h2 class="fw-bold mb-1" style="font-size:1.5rem;">로그인</h2>
      <p class="text-muted mb-4" style="font-size:0.9375rem;">회사 이메일 계정으로 접속하세요.</p>

      <!-- 무음 재로그인(prompt=none) 왕복 중 스켈레톤 — docs/design/google-oauth-login.md §4.3(d).
           폼을 그리지 않은 채 이동하므로 "폼이 떴다가 사라지는" 플래시가 없다. -->
      <div v-if="silentPending" class="login-silent-skeleton d-flex flex-column align-items-center justify-content-center text-center py-5" style="min-height: 220px;">
        <div class="spinner-border text-primary mb-3" role="status">
          <span class="visually-hidden">로그인 상태 확인 중…</span>
        </div>
        <p class="text-muted small mb-0">로그인 상태 확인 중…</p>
      </div>

      <!-- Google 핸드오프 교환 성공 + must_change_password인 경우의 해제 가능한 안내(결정 5).
           /profile로 강제 이동시키지 않는다 — "계속하기"로 사용자가 직접 원래 목적지로 진행한다. -->
      <div v-else-if="mustChangePasswordNotice" class="py-2">
        <div class="alert alert-warning small mb-3" role="alert">
          임시 비밀번호가 아직 유효합니다. 프로필에서 변경을 권장합니다.
        </div>
        <button type="button" class="btn btn-primary w-100" @click="dismissMustChangePasswordNotice">계속하기</button>
      </div>

      <template v-else>
        <form @submit.prevent="submit">
          <div class="mb-3">
            <label class="form-label small fw-semibold" for="loginEmail">이메일</label>
            <input
              id="loginEmail"
              ref="email"
              v-model="email"
              type="email"
              class="form-control"
              autocomplete="username"
              :disabled="loading"
              placeholder="name@malgnsoft.com"
            />
          </div>

          <div class="mb-3">
            <label class="form-label small fw-semibold" for="loginPw">비밀번호</label>
            <input
              id="loginPw"
              ref="pw"
              v-model="password"
              type="password"
              class="form-control"
              autocomplete="current-password"
              :disabled="loading"
              placeholder="비밀번호"
            />
          </div>

          <div v-if="error" class="alert alert-danger py-2 small mb-3" role="alert">{{ error }}</div>

          <button type="submit" class="btn btn-primary w-100" :disabled="submitDisabled">
            <span v-if="loading" class="spinner-border spinner-border-sm me-2"></span>
            {{ loading ? '확인 중…' : '로그인' }}
          </button>
        </form>

        <div class="d-flex align-items-center gap-2 my-3">
          <hr class="flex-grow-1 my-0 border-hairline">
          <span class="text-muted small">또는</span>
          <hr class="flex-grow-1 my-0 border-hairline">
        </div>

        <button
          type="button"
          class="btn btn-outline-secondary w-100 d-flex align-items-center justify-content-center gap-2"
          :disabled="loading"
          @click="goGoogleInteractive"
        >
          <i class="bi bi-google"></i>
          Google로 로그인
        </button>
      </template>
    </div>
    </div>
  </div>
</template>

<script>
// Google 로그인 병행 + 무음 재로그인(prompt=none) 구현.
// 설계 정본: docs/design/google-oauth-login.md 결정 10 + §4.3(무음 재로그인 프런트 구현 지시서).
// 3개 브라우저 저장소 키(§4.3.0): mh_g_linked(localStorage, 옵트인), mh_g_silent_tried(sessionStorage,
// 탭당 1회 차단기), mh_g_silent_off(localStorage, 억제). 값은 전부 '1' 문자열 하나뿐.
export default {
  // 가드 제외 + 레이아웃(사이드바) 없이 단독 렌더.
  layout: false,
  auth: false,
  title: '로그인 · malgnai-hub',
  data() {
    return {
      email: '',
      password: '',
      loading: false,
      error: '',
      silentPending: false,
      mustChangePasswordNotice: false,
      pendingRedirectPath: '/',
      _silentTimeoutId: null,
    }
  },
  computed: {
    submitDisabled() {
      return this.loading || !this.email.trim() || !this.password
    },
  },
  mounted() {
    // 판정 순서(§3.4·§4.3.1) — ① 해시 처리(gh/ge) → ② 기존 유효 토큰 → ③ 무음 시도 판정 → ④ 폼 표시.
    // 이 순서를 바꾸면 무음 왕복에서 돌아온 사용자가 다시 무음으로 나가는 루프가 생긴다.
    const hashParams = this.parseHash()

    if (hashParams.has('gh')) {
      this.handleHandoff(hashParams.get('gh'))
      return
    }
    if (hashParams.has('ge')) {
      this.handleGoogleError(hashParams.get('ge'), hashParams.get('gs') === '1')
      this.$nextTick(() => this.$refs.email?.focus())
      return
    }

    // 이미 유효한 토큰이 있으면 대시보드로. 무음 판정 없음.
    if (this.hasValidToken()) {
      this.$router.replace(this.redirectTarget())
      return
    }

    if (this.shouldAttemptSilent()) {
      this.startSilentLogin()
      return
    }

    this.$refs.email?.focus()
  },
  beforeUnmount() {
    if (this._silentTimeoutId) {
      clearTimeout(this._silentTimeoutId)
      this._silentTimeoutId = null
    }
  },
  methods: {
    hasValidToken() {
      try {
        const t = localStorage.getItem('token')
        if (!t) return false
        const p = decodeJwtPayload(t)
        return !!p && (!p.exp || p.exp * 1000 > Date.now())
      } catch {
        return false
      }
    },
    redirectTarget() {
      const r = this.$route.query.redirect
      return typeof r === 'string' && r.startsWith('/') ? r : '/'
    },

    // 저장소 접근은 전부 try/catch로 감싼다 — 예외가 나면 "시도하지 않는다"로 폴백한다(§4.3.0 fail-closed).
    safeGet(storage, key) {
      try {
        return storage.getItem(key)
      } catch {
        return null
      }
    },
    safeSet(storage, key, value) {
      try {
        storage.setItem(key, value)
      } catch {
        // no-op — 저장 실패는 무시(다음 판정에서 자연히 fail-closed로 이어진다)
      }
    },
    safeRemove(storage, key) {
      try {
        storage.removeItem(key)
      } catch {
        // no-op
      }
    },

    parseHash() {
      const raw = window.location.hash || ''
      return new URLSearchParams(raw.startsWith('#') ? raw.slice(1) : raw)
    },
    clearHash() {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    },

    // §4.3.1 판정 로직 4)5) — refresh_token이 있으면 무음 시도 안 함(부트 사전갱신과 경쟁 방지),
    // 그 외 mh_g_linked/mh_g_silent_tried/mh_g_silent_off 3조건이 모두 참이어야 무음 시도.
    shouldAttemptSilent() {
      if (this.safeGet(localStorage, 'refresh_token')) return false
      if (this.safeGet(localStorage, 'mh_g_linked') !== '1') return false
      if (this.safeGet(sessionStorage, 'mh_g_silent_tried') === '1') return false
      if (this.safeGet(localStorage, 'mh_g_silent_off') === '1') return false
      return true
    },

    // §4.3(a)(c)(d) — top-level 리디렉트, 마커를 먼저 쓰고 나중에 이동, 동기 판정으로 첫 페인트 전
    // 스켈레톤을 그려 깜빡임을 없앤다. 8초 타임아웃 안전장치는 이동이 일어나지 않는 극단적인 경우의
    // 대비다(정상적으로 이동하면 페이지가 파괴되어 타이머는 자연히 사라진다).
    startSilentLogin() {
      this.silentPending = true
      this.safeSet(sessionStorage, 'mh_g_silent_tried', '1')
      this._silentTimeoutId = setTimeout(() => {
        this.silentPending = false
      }, 8000)
      window.location.replace('/api/auth/google/start?silent=1&redirect=' + encodeURIComponent(this.redirectTarget()))
    },

    // §3.4 — 버튼 클릭은 SPA 라우팅이 가로채면 안 되므로 전체 페이지 이동. §4.3(e)-3: 사용자의
    // 가장 최근 명시적 선택이 항상 이기므로 억제 마커를 해제한다.
    goGoogleInteractive() {
      this.safeRemove(localStorage, 'mh_g_silent_off')
      window.location.href = '/api/auth/google/start?redirect=' + encodeURIComponent(this.redirectTarget())
    },

    // §3.4 + 결정6 — 핸드오프 코드를 same-origin POST로 토큰 쌍으로 교환한다.
    async handleHandoff(handoffCode) {
      this.clearHash()
      this.silentPending = true

      const { data, error } = await useApi('/api/auth/google/exchange', {
        method: 'POST',
        body: { handoff_code: handoffCode },
      })

      if (data?.token) {
        localStorage.setItem('token', data.token)
        if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token)
        // Google 로그인 성공 — 옵트인 마커를 세우고 억제를 해제한다(§4.3.0).
        this.safeSet(localStorage, 'mh_g_linked', '1')
        this.safeRemove(localStorage, 'mh_g_silent_off')

        const target = typeof data.redirect_path === 'string' && data.redirect_path.startsWith('/')
          ? data.redirect_path
          : this.redirectTarget()

        if (data.must_change_password) {
          // 결정 5 — /profile로 강제 이동시키지 않는다. 해제 가능한 안내를 띄운다.
          this.silentPending = false
          this.mustChangePasswordNotice = true
          this.pendingRedirectPath = target
          return
        }

        this.$router.replace(target)
        return
      }

      // 교환 실패(§3.3): INVALID_HANDOFF/UNAUTHORIZED/NOT_FOUND/VALIDATION_ERROR
      this.silentPending = false

      // reviewer m-8: 무음 재로그인(prompt=none) 왕복이 성공해 #gh=까지 왔는데 그 사이 60초 만료·
      // 이미 소비 등으로 /exchange가 INVALID_HANDOFF로 실패하면, 사용자가 이번 탭에서 시작하지 않은
      // 동작이므로 §3.2 "조용한 폴백" 원칙을 여기까지 연장한다 — 배너 없이 조용히 폼을 보여준다.
      const wasSilentRoundTrip = this.safeGet(sessionStorage, 'mh_g_silent_tried') === '1'
      if (wasSilentRoundTrip && error?.code === 'INVALID_HANDOFF') {
        this.$nextTick(() => this.$refs.email?.focus())
        return
      }

      this.error = this.exchangeErrorMessage(error)
      this.$nextTick(() => this.$refs.email?.focus())
    },

    dismissMustChangePasswordNotice() {
      this.mustChangePasswordNotice = false
      this.$router.replace(this.pendingRedirectPath || '/')
    },

    exchangeErrorMessage(error) {
      const code = error?.code
      if (code === 'INVALID_HANDOFF') return '로그인 요청이 만료되었거나 이미 사용되었습니다. 다시 시도해주세요.'
      if (code === 'UNAUTHORIZED') return '비활성화된 계정입니다. 관리자에게 문의하세요.'
      if (code === 'NOT_FOUND') return '계정 정보를 찾을 수 없습니다. 관리자에게 문의하세요.'
      if (code === 'VALIDATION_ERROR') return '로그인 요청 형식이 올바르지 않습니다.'
      return error?.message || (typeof error === 'string' ? error : 'Google 로그인에 실패했습니다.')
    },

    // §3.2 — GET /api/auth/google/callback이 돌려주는 ge 코드 처리. 무음 왕복(gs=1)이면 §3.2의
    // "조용한 폴백/표시하는 거부" 두 갈래로 나눈다. /start 단계 에러(not_configured·origin_not_allowed)는
    // 서버가 mode를 echo하지 않으므로(위조 방지를 위해 콜백에서만 state 행 mode를 신뢰) 이 탭이
    // 방금 무음으로 나갔는지(mh_g_silent_tried)로 판단한다 — §3.1 "판단 기준은 프런트가 보관한
    // '이번 왕복이 무음이었는가'".
    handleGoogleError(code, gsFlag) {
      this.clearHash()
      this.silentPending = false
      this.error = ''

      const SILENT_QUIET = new Set([
        'silent_unavailable', 'silent_suppressed', 'invalid_flow',
        'flow_binding_failed', 'upstream', 'not_configured', 'origin_not_allowed',
      ])
      const MESSAGES = {
        google_denied: 'Google 로그인이 취소되었습니다.',
        invalid_flow: '로그인 요청이 만료되었습니다. 다시 시도해주세요.',
        flow_binding_failed: '로그인 요청을 처리하지 못했습니다. 다른 탭에서 로그인을 다시 시도했거나 브라우저가 쿠키를 차단했을 수 있습니다. 쿠키 허용 여부를 확인한 후 다시 시도해주세요.',
        upstream: '일시적으로 로그인을 처리할 수 없습니다. 잠시 후 다시 시도해주세요.',
        email_unverified: '이메일이 확인되지 않은 Google 계정입니다.',
        hd_mismatch: '회사 Google 계정으로 로그인해주세요.',
        domain_mismatch: '회사 Google 계정으로 로그인해주세요.',
        not_provisioned: 'malgnai-hub 계정이 없습니다. 관리자에게 계정 발급을 요청하세요.',
        user_disabled: '비활성화된 계정입니다. 관리자에게 문의하세요.',
        sub_mismatch: '이 계정에 연결된 Google 계정이 아닙니다. 관리자에게 문의하세요.',
        sub_conflict: '이 계정에 연결된 Google 계정이 아닙니다. 관리자에게 문의하세요.',
        not_configured: 'Google 로그인이 아직 설정되지 않았습니다. 이메일/비밀번호로 로그인하세요.',
        origin_not_allowed: '이 주소에서는 Google 로그인을 사용할 수 없습니다. https://malgnai-hub.apiserver.kr 에서 이용하세요.',
      }

      const wasSilent = gsFlag || code === 'silent_suppressed' ||
        ((code === 'not_configured' || code === 'origin_not_allowed') &&
          this.safeGet(sessionStorage, 'mh_g_silent_tried') === '1')

      if (wasSilent) {
        // "표시하는 거부" 갈래만 문구를 띄운다 — "조용한 폴백" 갈래는 사용자를 특정하지 못한 채
        // 끝났거나 사용자가 시작하지 않은 동작이므로 알릴 내용이 없다.
        if (!SILENT_QUIET.has(code)) {
          this.error = MESSAGES[code] || 'Google 로그인에 실패했습니다.'
        }
        // 두 갈래 모두 억제 마커를 세운다(§4.3.0 mh_g_silent_off 쓰는 곳).
        this.safeSet(localStorage, 'mh_g_silent_off', '1')
        return
      }

      // 인터랙티브(버튼 클릭) 경로 — §3.2 표의 문구를 그대로 띄운다.
      this.error = MESSAGES[code] || 'Google 로그인에 실패했습니다.'
    },

    async submit() {
      this.error = ''
      this.loading = true

      const { data, error } = await useApi('/api/auth/login', {
        method: 'POST',
        body: { email: this.email.trim(), password: this.password },
      })
      this.loading = false

      if (data?.token) {
        localStorage.setItem('token', data.token)
        if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token)
        if (data.must_change_password) {
          alert('임시/초기 비밀번호로 로그인했습니다. 계속 사용하려면 비밀번호를 변경해주세요.')
          this.$router.replace('/profile')
          return
        }
        this.$router.replace(this.redirectTarget())
        return
      }

      // 에러 분기 — docs/api.md §5.1: 비번 틀림 401 INVALID_CREDENTIALS, 그 외 400 VALIDATION_ERROR.
      const code = error?.code
      if (code === 'INVALID_CREDENTIALS') {
        this.error = '이메일 또는 비밀번호가 올바르지 않습니다.'
      } else if (code === 'VALIDATION_ERROR') {
        this.error = '입력값을 확인해주세요.'
      } else {
        this.error = error?.message || (typeof error === 'string' ? error : '로그인에 실패했습니다.')
      }
      this.password = ''
      this.$nextTick(() => this.$refs.pw?.focus())
    },
  },
}
</script>

<style>
/* 좌측 브랜드 패널 */
.login-brand {
  flex: 0 0 42%;
  background: var(--gradient-brand);
  position: relative;
  overflow: hidden;
}
.login-brand::after {
  content: ""; position: absolute; inset: 0;
  background: radial-gradient(120% 80% at 80% 0%, rgba(255,255,255,0.18), transparent 60%);
  pointer-events: none;
}
.login-brand > * { position: relative; z-index: 1; }

.login-brand-mark {
  width: 32px; height: 32px; border-radius: var(--rounded-md);
  background: rgba(255,255,255,0.15); backdrop-filter: blur(4px);
}
.login-brand-mark--sm { width: 26px; height: 26px; background: var(--color-primary); }

/* 폼 카드 */
.login-card {
  width: 100%; max-width: 400px;
  border-radius: var(--rounded-xl);
  box-shadow: var(--shadow-lg);
}
</style>
