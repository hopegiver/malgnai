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
    </div>
    </div>
  </div>
</template>

<script>
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
    }
  },
  computed: {
    submitDisabled() {
      return this.loading || !this.email.trim() || !this.password
    },
  },
  mounted() {
    // 이미 유효한 토큰이 있으면 대시보드로.
    if (this.hasValidToken()) {
      this.$router.replace(this.redirectTarget())
      return
    }
    this.$refs.email?.focus()
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
