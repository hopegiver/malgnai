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
        <span class="fw-bold fs-5 text-white">맑은AI</span>
      </div>
      <div>
        <div class="login-pulse mb-4"><span></span></div>
        <h1 class="text-white fw-bold mb-3" style="font-size:1.9rem; line-height:1.25; letter-spacing:-0.03rem;">
          AI가 스스로 진행하는<br>자율 프로젝트 운영 플랫폼
        </h1>
        <p class="mb-0" style="color:rgba(255,255,255,0.78); font-size:0.95rem;">
          프로젝트를 만들면, 지정 에이전트가 심장박동마다 스스로 판단·수행합니다.
        </p>
      </div>
      <p class="mb-0" style="color:rgba(255,255,255,0.55); font-size:0.8125rem;">© 맑은소프트 · malgnai</p>
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
        <span class="fw-bold fs-6">맑은AI</span>
      </div>
      <h2 class="fw-bold mb-1" style="font-size:1.5rem;">로그인</h2>
      <p class="text-muted mb-4" style="font-size:0.9375rem;">AI 자율 프로젝트 운영 플랫폼에 접속하세요.</p>

      <form @submit.prevent="submit">
        <div class="mb-3">
          <label class="form-label small fw-semibold">아이디</label>
          <input
            ref="id"
            v-model="username"
            type="text"
            class="form-control"
            autocomplete="username"
            :disabled="loading || totpRequired"
            placeholder="아이디"
          />
        </div>

        <div class="mb-3">
          <label class="form-label small fw-semibold">비밀번호</label>
          <input
            ref="pw"
            v-model="password"
            type="password"
            class="form-control"
            autocomplete="current-password"
            :disabled="loading || totpRequired"
            placeholder="비밀번호"
          />
        </div>

        <!-- TOTP 단계: totp_required 응답을 받은 뒤에만 노출 -->
        <div v-if="totpRequired" class="mb-3">
          <label class="form-label small fw-semibold">인증 코드</label>
          <input
            ref="code"
            v-model="code"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]*"
            maxlength="6"
            class="form-control login-code-input"
            :disabled="loading"
            placeholder="000000"
            @input="onCodeInput"
          />
          <div class="form-text small">Google Authenticator 6자리 코드를 입력하세요.</div>
        </div>

        <div v-if="error" class="alert alert-danger py-2 small mb-3" role="alert">{{ error }}</div>

        <button type="submit" class="btn btn-primary w-100" :disabled="submitDisabled">
          <span v-if="loading" class="spinner-border spinner-border-sm me-2"></span>
          {{ buttonLabel }}
        </button>

        <button
          v-if="totpRequired"
          type="button"
          class="btn btn-link btn-sm w-100 mt-2 text-muted"
          :disabled="loading"
          @click="resetToPassword"
        >
          비밀번호 다시 입력
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
  title: '로그인 · 맑은AI',
  data() {
    return {
      username: '',
      password: '',
      code: '',
      totpRequired: false,
      loading: false,
      error: '',
    }
  },
  computed: {
    buttonLabel() {
      if (this.loading) return '확인 중…'
      return this.totpRequired ? '인증' : '로그인'
    },
    submitDisabled() {
      if (this.loading) return true
      if (this.totpRequired) return this.code.length !== 6
      return !this.username || !this.password
    },
  },
  mounted() {
    // 이미 유효한 토큰이 있으면 대시보드로.
    if (this.hasValidToken()) {
      this.$router.replace(this.redirectTarget())
      return
    }
    this.$refs.id?.focus()
  },
  methods: {
    hasValidToken() {
      try {
        const t = localStorage.getItem('token')
        if (!t) return false
        const p = JSON.parse(atob(t.split('.')[1]))
        return !p.exp || p.exp * 1000 > Date.now()
      } catch {
        return false
      }
    },
    redirectTarget() {
      const r = this.$route.query.redirect
      return typeof r === 'string' && r.startsWith('/') ? r : '/'
    },
    onCodeInput() {
      // 숫자만 허용, 최대 6자리.
      this.code = this.code.replace(/\D/g, '').slice(0, 6)
    },
    resetToPassword() {
      this.totpRequired = false
      this.code = ''
      this.error = ''
      this.$nextTick(() => this.$refs.pw?.focus())
    },
    async submit() {
      this.error = ''
      this.loading = true

      const body = { username: this.username, password: this.password }
      if (this.totpRequired) body.code = this.code

      const { data, error } = await useApi('/api/auth/login', {
        method: 'POST',
        body,
      })
      this.loading = false

      if (data?.token) {
        localStorage.setItem('token', data.token)
        this.$router.replace(this.redirectTarget())
        return
      }

      // 에러 분기 (계약 기준)
      switch (error) {
        case 'totp_required':
          this.totpRequired = true
          this.error = ''
          this.$nextTick(() => this.$refs.code?.focus())
          break
        case 'invalid_code':
          this.error = '인증 코드가 올바르지 않습니다.'
          this.code = ''
          this.$nextTick(() => this.$refs.code?.focus())
          break
        case 'invalid_credentials':
          this.error = '아이디 또는 비밀번호가 올바르지 않습니다.'
          this.totpRequired = false
          this.password = ''
          this.code = ''
          this.$nextTick(() => this.$refs.pw?.focus())
          break
        default:
          this.error = error || '로그인에 실패했습니다.'
          if (!this.totpRequired) {
            this.password = ''
            this.$nextTick(() => this.$refs.pw?.focus())
          }
      }
    },
  },
}
</script>

<style>
.login-code-input {
  letter-spacing: 0.4em;
  font-size: 1.25rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

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

/* 자율 "broadcast" 펄스 링 (autonomy 화면 모티프와 통일) */
.login-pulse { position: relative; width: 14px; height: 14px; }
.login-pulse span {
  position: absolute; inset: 0; border-radius: 50%;
  background: #7fffd4; box-shadow: 0 0 0 0 rgba(127,255,212,0.6);
  animation: loginPulse 2.4s var(--ease-out-back) infinite;
}
@keyframes loginPulse {
  0%   { box-shadow: 0 0 0 0 rgba(127,255,212,0.5); }
  70%  { box-shadow: 0 0 0 16px rgba(127,255,212,0); }
  100% { box-shadow: 0 0 0 0 rgba(127,255,212,0); }
}
@media (prefers-reduced-motion: reduce) { .login-pulse span { animation: none; } }

/* 폼 카드: 340px 고정 → 유동 + 큰 라운드/그림자 (base.css .login-card 오버라이드) */
.login-card {
  width: 100%; max-width: 400px;
  border-radius: var(--rounded-xl);
  box-shadow: var(--shadow-lg);
}
</style>
