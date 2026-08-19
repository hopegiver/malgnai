<template>
  <div class="d-flex justify-content-center align-items-center min-vh-100 p-3">
    <div class="oauth-card card p-4 p-sm-5">
      <div class="text-center mb-4">
        <div class="oauth-icon mb-3"><i class="bi bi-shield-lock"></i></div>
        <h1 class="h4 mb-1">앱 접근 허용</h1>
        <p class="text-muted small mb-0">외부 애플리케이션이 이 계정으로 malgnai-hub에 접근하는 것을 요청합니다.</p>
      </div>

      <!-- 필수 파라미터 누락 -->
      <div v-if="paramsError" class="alert alert-warning small mb-0">
        <i class="bi bi-exclamation-triangle me-1"></i>잘못된 인증 요청입니다. 요청을 시작한 앱에서 다시 시도해주세요.
      </div>

      <!-- 클라이언트 정보 조회 중 -->
      <div v-else-if="loading" class="text-center text-muted py-4">
        <span class="spinner-border spinner-border-sm me-2"></span>인증 정보를 확인하는 중...
      </div>

      <!-- 클라이언트 정보 조회 실패 -->
      <div v-else-if="contextError" class="alert alert-warning small mb-0">
        <i class="bi bi-exclamation-triangle me-1"></i>{{ contextError }}
      </div>

      <!-- 동의 확인 -->
      <template v-else>
        <div class="oauth-client-box text-center mb-3">
          <div class="fs-5 fw-bold text-truncate mb-1">{{ clientName }}</div>
          <div class="text-muted small">이(가) 당신의 malgnai-hub 계정에 접근하려고 합니다</div>
        </div>

        <div v-if="trust === 'unverified'" class="oauth-warn-box d-flex align-items-start gap-2 mb-3">
          <i class="bi bi-exclamation-triangle-fill flex-shrink-0 mt-1"></i>
          <div class="small">
            이 클라이언트는 등록된 지 얼마 안 됐고<template v-if="registeredAt">({{ formatRelative(registeredAt) }})</template>
            아직 아무도 승인한 적이 없습니다. 신뢰할 수 있는 앱인지 확인하세요.
          </div>
        </div>

        <div class="mb-4">
          <label class="form-label small fw-semibold" for="oauthDeviceName">기기 이름</label>
          <input
            id="oauthDeviceName"
            v-model="deviceName"
            type="text"
            class="form-control"
            placeholder="예: 내 노트북"
            :disabled="consenting"
          />
          <p class="text-faint small mt-2 mb-0">이 이름은 나중에 인증키 목록에서 이 접근을 구분하는 용도로만 쓰입니다.</p>
        </div>

        <div v-if="consentError" class="alert alert-danger py-2 small">{{ consentError }}</div>

        <div class="d-flex gap-2">
          <button type="button" class="btn btn-outline-secondary flex-grow-1" :disabled="consenting" @click="$router.push('/')">취소</button>
          <button type="button" class="btn btn-primary flex-grow-1" :disabled="consenting" @click="consent">
            <span v-if="consenting" class="spinner-border spinner-border-sm me-2"></span>
            허용
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script>
export default {
  // login.vue와 동일하게 vue-zero 전역 auth guard(index.html)를 우회한다 — 그 guard는
  // 미인증 시 항상 loginPage('/login', 쿼리 없음)로 보내 client_id/redirect_uri/state/
  // code_challenge를 전부 잃어버린다. 이 화면은 mounted()에서 직접 hasValidToken()을 확인해
  // fullPath(쿼리 포함)를 ?redirect=로 실어 보내야 로그인 후 이 화면으로 정확히 되돌아온다.
  // layout도 대시보드 사이드바 없이 login.vue처럼 단독 화면으로 렌더한다(외부 플러그인이 여는
  // 표준 OAuth consent 화면 UX).
  layout: false,
  auth: false,
  title: '앱 접근 허용 · malgnai-hub',
  data() {
    return {
      clientId: '',
      redirectUri: '',
      state: '',
      codeChallenge: '',
      codeChallengeMethod: 'S256',
      scope: '',
      deviceName: '',

      paramsError: false,
      loading: true,
      contextError: '',

      clientName: '',
      trust: '',
      registeredAt: '',

      consenting: false,
      consentError: '',
    }
  },
  async mounted() {
    const q = this.$route.query
    this.clientId = typeof q.client_id === 'string' ? q.client_id : ''
    this.redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : ''
    this.state = typeof q.state === 'string' ? q.state : ''
    this.codeChallenge = typeof q.code_challenge === 'string' ? q.code_challenge : ''
    this.codeChallengeMethod = typeof q.code_challenge_method === 'string' && q.code_challenge_method
      ? q.code_challenge_method
      : 'S256'
    this.scope = typeof q.scope === 'string' ? q.scope : ''

    if (!this.clientId || !this.redirectUri || !this.state || !this.codeChallenge) {
      this.paramsError = true
      this.loading = false
      return
    }

    if (!this.hasValidToken()) {
      this.$router.replace(`/login?redirect=${encodeURIComponent(this.$route.fullPath)}`)
      return
    }

    await this.fetchContext()
  },
  methods: {
    // login.vue의 hasValidToken()과 동일 로직(localStorage.token + decodeJwtPayload의 exp 확인).
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
    async fetchContext() {
      this.loading = true
      this.contextError = ''
      const { data, error } = await useApi('/api/oauth/authorize-context', {
        method: 'POST',
        body: { client_id: this.clientId, redirect_uri: this.redirectUri },
      })
      this.loading = false
      if (error) {
        // docs/api.md 표준 에러 형태: { code: 'invalid_client' | 'invalid_redirect_uri', message }.
        this.contextError = error?.message || (typeof error === 'string' ? error : '클라이언트 정보를 확인하지 못했습니다.')
        return
      }
      const payload = data?.data ?? data
      this.clientName = payload?.client_name || this.clientId
      this.trust = payload?.trust || 'unverified'
      this.registeredAt = payload?.registered_at || ''
    },
    async consent() {
      this.consenting = true
      this.consentError = ''
      const { data, error } = await useApi('/api/oauth/consent', {
        method: 'POST',
        body: {
          client_id: this.clientId,
          redirect_uri: this.redirectUri,
          code_challenge: this.codeChallenge,
          code_challenge_method: this.codeChallengeMethod,
          scope: this.scope,
          state: this.state,
          device_name: this.deviceName.trim() || null,
        },
      })
      this.consenting = false
      if (error) {
        this.consentError = error?.message || '승인 처리에 실패했습니다. 다시 시도해주세요.'
        return
      }
      const redirectUri = data?.data?.redirect_uri ?? data?.redirect_uri
      if (!redirectUri) {
        this.consentError = '리다이렉트 주소를 받지 못했습니다. 다시 시도해주세요.'
        return
      }
      // 외부(127.0.0.1 로컬 콜백 서버 등)로 나가야 하므로 Vue Router가 아닌 실제 브라우저 이동을 쓴다.
      window.location.href = redirectUri
    },
    formatRelative,
  },
}
</script>

<style>
.oauth-card { width: 100%; max-width: 440px; border-radius: var(--rounded-xl); box-shadow: var(--shadow-lg); }
.oauth-icon {
  width: 52px; height: 52px; margin: 0 auto; border-radius: var(--rounded-full);
  background: var(--color-brand-soft); color: var(--color-brand);
  display: flex; align-items: center; justify-content: center; font-size: 1.5rem;
}
.oauth-client-box {
  padding: 0.875rem 1rem; border-radius: var(--rounded-lg);
  background: var(--color-canvas-soft); border: 1px solid var(--color-hairline);
}
.oauth-warn-box {
  padding: 0.75rem 1rem; border-radius: var(--rounded-lg);
  background: var(--color-warning-soft); border: 1px solid var(--color-warning);
  color: var(--color-warning-text);
}
</style>
