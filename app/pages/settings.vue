<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h1 class="mb-0">설정</h1>
    </div>

    <!-- 로드 에러 -->
    <div v-if="error" class="alert alert-danger d-flex justify-content-between align-items-center" role="alert">
      <span><i class="bi bi-exclamation-triangle me-2"></i>{{ error }}</span>
      <button type="button" class="btn btn-sm btn-outline-danger" @click="load">다시 시도</button>
    </div>

    <!-- 성공/안내 토스트 -->
    <div v-if="toast" class="alert alert-success py-2" role="status">
      <i class="bi bi-check-circle me-2"></i>{{ toast }}
    </div>

    <!-- 로딩 -->
    <div v-if="loading" class="text-muted py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중…</div>

    <div v-else class="settings-grid">
      <!-- 계정 정보 -->
      <div class="card p-4 mb-3">
        <h5 class="mb-3"><i class="bi bi-person-circle me-2"></i>계정</h5>
        <div class="d-flex align-items-center justify-content-between">
          <span class="text-muted small">사용자</span>
          <span class="fw-semibold">{{ username || '—' }}</span>
        </div>
        <div v-if="role" class="d-flex align-items-center justify-content-between mt-2">
          <span class="text-muted small">권한</span>
          <span class="badge" :class="role === 'admin' ? 'bg-primary' : 'bg-secondary'">
            {{ role === 'admin' ? '관리자' : '일반' }}
          </span>
        </div>
      </div>

      <!-- 비밀번호 변경 -->
      <div class="card p-4 mb-3">
        <h5 class="mb-3"><i class="bi bi-key me-2"></i>비밀번호 변경</h5>

        <div v-if="pwError" class="alert alert-danger py-2 small mb-3" role="alert">
          <i class="bi bi-exclamation-triangle me-2"></i>{{ pwError }}
        </div>

        <form @submit.prevent="changePassword" autocomplete="off">
          <div class="mb-3" style="max-width: 360px;">
            <label class="form-label small fw-semibold">현재 비밀번호</label>
            <input v-model="curPw" type="password" class="form-control" autocomplete="current-password" :disabled="pwBusy" />
          </div>
          <div class="mb-3" style="max-width: 360px;">
            <label class="form-label small fw-semibold">새 비밀번호 <span class="text-muted fw-normal">(8자 이상)</span></label>
            <input v-model="newPw" type="password" class="form-control" autocomplete="new-password" :disabled="pwBusy" />
          </div>
          <div class="mb-3" style="max-width: 360px;">
            <label class="form-label small fw-semibold">새 비밀번호 확인</label>
            <input v-model="newPw2" type="password" class="form-control" autocomplete="new-password" :disabled="pwBusy" />
          </div>
          <button type="submit" class="btn btn-primary" :disabled="pwBusy || !curPw || !newPw || !newPw2">
            <span v-if="pwBusy" class="spinner-border spinner-border-sm me-2"></span>
            비밀번호 변경
          </button>
        </form>
      </div>

      <!-- 2단계 인증 -->
      <div class="card p-4">
        <div class="d-flex align-items-start justify-content-between mb-3">
          <div>
            <h5 class="mb-1"><i class="bi bi-shield-lock me-2"></i>2단계 인증 (2FA)</h5>
            <p class="text-muted small mb-0">로그인 시 비밀번호에 더해 Google Authenticator 인증 코드를 요구합니다.</p>
          </div>
          <span
            class="badge align-self-center"
            :class="totpEnabled ? 'bg-success' : 'bg-secondary'"
          >{{ totpEnabled ? '사용 중' : '꺼짐' }}</span>
        </div>

        <hr class="my-3" />

        <!-- 작업별 에러 -->
        <div v-if="actionError" class="alert alert-danger py-2 small mb-3" role="alert">
          <i class="bi bi-exclamation-triangle me-2"></i>{{ actionError }}
        </div>

        <!-- === 꺼져 있을 때: 설정 플로우 === -->
        <template v-if="!totpEnabled">
          <!-- 1단계: 설정 시작 전 -->
          <div v-if="!setup">
            <button type="button" class="btn btn-primary" :disabled="busy" @click="startSetup">
              <span v-if="busy" class="spinner-border spinner-border-sm me-2"></span>
              2단계 인증 설정
            </button>
          </div>

          <!-- 2단계: QR + 코드 입력 -->
          <div v-else>
            <p class="small mb-3">
              휴대폰 <b>Google Authenticator</b> 앱으로 아래 QR을 스캔하세요.
              QR 스캔이 어려우면 아래 키를 수동으로 입력할 수 있습니다.
            </p>

            <div class="row g-4 align-items-start">
              <div class="col-12 col-sm-auto text-center">
                <img
                  v-if="setup.qr_data_url"
                  :src="setup.qr_data_url"
                  alt="2단계 인증 QR 코드"
                  class="settings-qr border border-hairline rounded-3 p-2 bg-white"
                  width="200"
                  height="200"
                />
                <div v-else class="settings-qr d-flex align-items-center justify-content-center border border-hairline rounded-3 text-muted small">
                  QR 없음
                </div>
              </div>

              <div class="col-12 col-sm">
                <label class="form-label small fw-semibold">수동 입력 키 (otpauth)</label>
                <div class="input-group input-group-sm mb-3">
                  <input
                    type="text"
                    class="form-control font-monospace small"
                    :value="setup.otpauth_url"
                    readonly
                    @focus="$event.target.select()"
                  />
                  <button type="button" class="btn btn-outline-secondary" @click="copy(setup.otpauth_url)" title="복사">
                    <i class="bi" :class="copied ? 'bi-check2' : 'bi-clipboard'"></i>
                  </button>
                </div>

                <label class="form-label small fw-semibold">인증 코드</label>
                <input
                  ref="enableCode"
                  v-model="enableCode"
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  pattern="[0-9]*"
                  maxlength="6"
                  class="form-control settings-code-input mb-3"
                  placeholder="000000"
                  :disabled="busy"
                  @input="enableCode = enableCode.replace(/\D/g, '').slice(0, 6)"
                />

                <div class="d-flex gap-2">
                  <button type="button" class="btn btn-primary" :disabled="busy || enableCode.length !== 6" @click="enable">
                    <span v-if="busy" class="spinner-border spinner-border-sm me-2"></span>
                    활성화
                  </button>
                  <button type="button" class="btn btn-light" :disabled="busy" @click="cancelSetup">취소</button>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- === 켜져 있을 때: 비활성화 플로우 === -->
        <template v-else>
          <p class="small mb-3">
            <i class="bi bi-check-circle-fill text-success me-1"></i>
            2단계 인증이 활성화되어 있습니다. 비활성화하려면 현재 인증 코드를 입력하세요.
          </p>
          <label class="form-label small fw-semibold">인증 코드</label>
          <input
            v-model="disableCode"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]*"
            maxlength="6"
            class="form-control settings-code-input mb-3"
            placeholder="000000"
            :disabled="busy"
            @input="disableCode = disableCode.replace(/\D/g, '').slice(0, 6)"
          />
          <button type="button" class="btn btn-outline-danger" :disabled="busy || disableCode.length !== 6" @click="disable">
            <span v-if="busy" class="spinner-border spinner-border-sm me-2"></span>
            2단계 인증 비활성화
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: '설정 · 맑은AI Monitor',
  data() {
    return {
      loading: true,
      error: '',
      actionError: '',
      toast: '',
      busy: false,

      username: '',
      role: '',
      totpEnabled: false,

      // 비밀번호 변경 상태
      curPw: '',
      newPw: '',
      newPw2: '',
      pwBusy: false,
      pwError: '',

      // 설정(setup) 플로우 상태
      setup: null, // { otpauth_url, qr_data_url }
      enableCode: '',
      disableCode: '',
      copied: false,
      _toastTimer: null,
    }
  },
  mounted() {
    this.load()
  },
  beforeUnmount() {
    clearTimeout(this._toastTimer)
  },
  methods: {
    async load() {
      this.loading = true
      this.error = ''
      const { data, error } = await useApi('/api/auth/me')
      this.loading = false
      if (error) {
        this.error = error
        return
      }
      this.username = data?.user?.username || ''
      this.role = data?.user?.role || ''
      this.totpEnabled = !!data?.totp_enabled
      // 상태 동기화 시 진행 중 설정 정리
      this.setup = null
      this.enableCode = ''
      this.disableCode = ''
    },
    showToast(msg) {
      this.toast = msg
      clearTimeout(this._toastTimer)
      this._toastTimer = setTimeout(() => { this.toast = '' }, 4000)
    },
    async changePassword() {
      this.pwError = ''
      if (this.newPw.length < 8) {
        this.pwError = '새 비밀번호는 최소 8자 이상이어야 합니다.'
        return
      }
      if (this.newPw !== this.newPw2) {
        this.pwError = '새 비밀번호 확인이 일치하지 않습니다.'
        return
      }
      this.pwBusy = true
      const { data, error } = await useApi('/api/auth/password', {
        method: 'POST',
        body: { current_password: this.curPw, new_password: this.newPw },
      })
      this.pwBusy = false
      if (error || !data?.ok) {
        this.pwError = error === 'invalid_password'
          ? '현재 비밀번호가 올바르지 않습니다.'
          : (error || '비밀번호 변경에 실패했습니다.')
        return
      }
      this.curPw = ''
      this.newPw = ''
      this.newPw2 = ''
      this.showToast('비밀번호가 변경되었습니다.')
    },
    async startSetup() {
      this.actionError = ''
      this.busy = true
      const { data, error } = await useApi('/api/auth/totp/setup', { method: 'POST' })
      this.busy = false
      if (error) {
        this.actionError = error || '설정 정보를 가져오지 못했습니다.'
        return
      }
      this.setup = data
      this.enableCode = ''
      this.$nextTick(() => this.$refs.enableCode?.focus())
    },
    cancelSetup() {
      this.setup = null
      this.enableCode = ''
      this.actionError = ''
    },
    async enable() {
      this.actionError = ''
      this.busy = true
      const { data, error } = await useApi('/api/auth/totp/enable', {
        method: 'POST',
        body: { code: this.enableCode },
      })
      this.busy = false
      if (error || !data?.ok) {
        this.actionError = error === 'invalid_code'
          ? '인증 코드가 올바르지 않습니다.'
          : (error || '활성화에 실패했습니다.')
        this.enableCode = ''
        this.$nextTick(() => this.$refs.enableCode?.focus())
        return
      }
      this.showToast('2단계 인증이 활성화되었습니다.')
      await this.load()
    },
    async disable() {
      this.actionError = ''
      this.busy = true
      const { data, error } = await useApi('/api/auth/totp/disable', {
        method: 'POST',
        body: { code: this.disableCode },
      })
      this.busy = false
      if (error || !data?.ok) {
        this.actionError = error === 'invalid_code'
          ? '인증 코드가 올바르지 않습니다.'
          : (error || '비활성화에 실패했습니다.')
        this.disableCode = ''
        return
      }
      this.showToast('2단계 인증이 비활성화되었습니다.')
      await this.load()
    },
    async copy(text) {
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        this.copied = true
        setTimeout(() => { this.copied = false }, 1500)
      } catch {
        // 클립보드 권한 없을 때는 무음 — 사용자가 직접 선택/복사 가능(readonly input).
      }
    },
  },
}
</script>

<style>
.settings-grid { max-width: 720px; }

.settings-qr {
  width: 200px;
  height: 200px;
  object-fit: contain;
}

.settings-code-input {
  letter-spacing: 0.4em;
  font-size: 1.25rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
  max-width: 220px;
}
</style>
