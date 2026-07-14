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

      <!-- 시스템 (관리자 전용) -->
      <div v-if="role === 'admin'" class="card p-4 mt-3">
        <h5 class="mb-1"><i class="bi bi-hdd-stack me-2"></i>시스템</h5>
        <p class="text-muted small mb-3">서버 프로세스를 재시작합니다. 진행 중인 요청/작업이 중단될 수 있습니다.</p>

        <div v-if="restartError" class="alert alert-danger py-2 small mb-3" role="alert">
          <i class="bi bi-exclamation-triangle me-2"></i>{{ restartError }}
        </div>

        <button type="button" class="btn btn-outline-danger" :disabled="restarting" @click="restartServer">
          <span v-if="restarting" class="spinner-border spinner-border-sm me-2"></span>
          서버 재시작
        </button>
      </div>

      <!-- 시스템 설정 (기타 app_settings, 관리자 전용) -->
      <div v-if="role === 'admin'" class="card p-4 mt-3">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h5 class="mb-0"><i class="bi bi-database-gear me-2"></i>시스템 설정 (기타)</h5>
          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="appSettingsLoading" @click="loadAppSettings">
            <i class="bi bi-arrow-clockwise me-1"></i>새로고침
          </button>
        </div>
        <p class="text-muted small mb-3">
          자율 킬스위치·엔진 설정은 <router-link to="/autonomy">자율 제어판</router-link>에서 관리합니다. 여기서는 그 외 <code>app_settings</code> 키를 직접 다룹니다.
        </p>

        <div v-if="appSettingsError" class="alert alert-danger py-2 small mb-3" role="alert">
          <i class="bi bi-exclamation-triangle me-2"></i>{{ appSettingsError }}
        </div>

        <div v-if="appSettingsLoading && !appSettings.length" class="text-muted small py-2">
          <span class="spinner-border spinner-border-sm me-2"></span>불러오는 중…
        </div>
        <div v-else-if="!appSettings.length" class="text-muted small py-2">등록된 기타 설정이 없습니다.</div>
        <div v-else class="table-responsive mb-3">
          <table class="table table-sm align-middle mb-0">
            <thead class="table-light">
              <tr>
                <th class="text-nowrap">키</th>
                <th>값</th>
                <th class="text-nowrap d-none d-md-table-cell">수정 시각</th>
                <th class="text-nowrap" style="width:8rem"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in appSettings" :key="s.key">
                <td class="text-nowrap font-monospace small">{{ s.key }}</td>
                <td>
                  <input
                    v-if="editingKey === s.key"
                    v-model="editValue"
                    type="text"
                    class="form-control form-control-sm"
                    :disabled="savingKey === s.key"
                    @keyup.enter="saveEdit(s)"
                    @keyup.esc="cancelEdit"
                  />
                  <span v-else class="text-break">{{ s.value }}</span>
                </td>
                <td class="d-none d-md-table-cell text-nowrap small text-muted">{{ fmtDate(s.updated_at) }}</td>
                <td class="text-nowrap">
                  <template v-if="editingKey === s.key">
                    <button type="button" class="btn btn-sm btn-primary me-1" :disabled="savingKey === s.key" @click="saveEdit(s)">
                      <span v-if="savingKey === s.key" class="spinner-border spinner-border-sm"></span>
                      <span v-else>저장</span>
                    </button>
                    <button type="button" class="btn btn-sm btn-light" :disabled="savingKey === s.key" @click="cancelEdit">취소</button>
                  </template>
                  <template v-else>
                    <button type="button" class="btn btn-sm btn-outline-secondary me-1" title="수정" @click="startEdit(s)"><i class="bi bi-pencil"></i></button>
                    <button type="button" class="btn btn-sm btn-outline-danger" title="삭제" :disabled="deletingKey === s.key" @click="deleteSetting(s)">
                      <span v-if="deletingKey === s.key" class="spinner-border spinner-border-sm"></span>
                      <i v-else class="bi bi-trash"></i>
                    </button>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <hr class="my-3" />

        <h6 class="small fw-semibold mb-2">새 키 추가</h6>
        <div v-if="addError" class="alert alert-danger py-2 small mb-2" role="alert">{{ addError }}</div>
        <form class="d-flex flex-wrap gap-2 align-items-end" @submit.prevent="addSetting">
          <div>
            <label class="form-label small mb-1">키</label>
            <input v-model.trim="newKey" type="text" class="form-control form-control-sm" style="width:14rem" placeholder="예: some.custom.key" :disabled="addBusy" />
          </div>
          <div>
            <label class="form-label small mb-1">값</label>
            <input v-model="newValue" type="text" class="form-control form-control-sm" style="width:14rem" :disabled="addBusy" />
          </div>
          <button type="submit" class="btn btn-sm btn-primary" :disabled="addBusy || !newKey">
            <span v-if="addBusy" class="spinner-border spinner-border-sm me-1"></span>추가
          </button>
        </form>
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

      // 서버 재시작 상태
      restarting: false,
      restartError: '',

      // 시스템 설정(기타 app_settings) 상태
      appSettings: [],
      appSettingsLoading: false,
      appSettingsError: '',
      editingKey: '',
      editValue: '',
      savingKey: '',
      deletingKey: '',
      newKey: '',
      newValue: '',
      addBusy: false,
      addError: '',
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
      if (this.role === 'admin') this.loadAppSettings()
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
    async restartServer() {
      if (!window.confirm('서버를 재시작할까요? 진행 중인 요청/작업이 중단될 수 있습니다.')) return
      this.restartError = ''
      this.restarting = true
      const { data, error } = await useApi('/api/system/restart', { method: 'POST' })
      if (error) {
        this.restarting = false
        this.restartError = error || '서버 재시작 요청에 실패했습니다.'
        return
      }
      this.showToast(data?.message || '서버를 재시작합니다. 잠시 후 다시 로그인해 주세요.')
      // restarting 스피너는 유지 — 서버가 내려갔다 올라오는 동안 재클릭 방지.
      // 재시작된 서버는 이전 세션 상태(SSE 연결 등)를 잃으므로 5초 뒤 로그아웃시켜
      // 사용자가 새로 로그인하며 최신 상태를 받도록 한다.
      setTimeout(() => logout(), 5000)
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
    isBlockedSettingKey(key) {
      return key === 'autonomy_enabled' || key.startsWith('engine.')
    },
    async loadAppSettings() {
      this.appSettingsLoading = true
      this.appSettingsError = ''
      const { data, error } = await useApi('/api/lead/app-settings')
      this.appSettingsLoading = false
      if (error) {
        this.appSettingsError = `기타 설정을 불러오지 못했습니다: ${error}`
        return
      }
      this.appSettings = data?.settings || []
    },
    startEdit(s) {
      this.editingKey = s.key
      this.editValue = s.value
    },
    cancelEdit() {
      this.editingKey = ''
      this.editValue = ''
    },
    async saveEdit(s) {
      this.savingKey = s.key
      const { data, error } = await useApi('/api/lead/app-settings', {
        method: 'PUT',
        body: { key: s.key, value: this.editValue },
      })
      this.savingKey = ''
      if (error) {
        this.appSettingsError = `${s.key} 저장에 실패했습니다: ${error}`
        return
      }
      s.value = data.value
      s.updated_at = data.updated_at
      this.editingKey = ''
      this.editValue = ''
      this.showToast(`${s.key} 값을 저장했습니다.`)
    },
    async deleteSetting(s) {
      if (!window.confirm(`'${s.key}' 설정을 삭제할까요? 되돌릴 수 없습니다.`)) return
      this.appSettingsError = ''
      this.deletingKey = s.key
      const { error } = await useApi(`/api/lead/app-settings/${encodeURIComponent(s.key)}`, { method: 'DELETE' })
      this.deletingKey = ''
      if (error) {
        this.appSettingsError = `${s.key} 삭제에 실패했습니다: ${error}`
        return
      }
      this.appSettings = this.appSettings.filter(x => x.key !== s.key)
      this.showToast(`${s.key} 설정을 삭제했습니다.`)
    },
    async addSetting() {
      this.addError = ''
      const key = (this.newKey || '').trim()
      if (!key) return
      if (this.isBlockedSettingKey(key)) {
        this.addError = 'autonomy_enabled / engine.* 로 시작하는 키는 자율 제어판에서 관리합니다.'
        return
      }
      this.addBusy = true
      const { data, error } = await useApi('/api/lead/app-settings', {
        method: 'PUT',
        body: { key, value: this.newValue },
      })
      this.addBusy = false
      if (error) {
        this.addError = error
        return
      }
      const idx = this.appSettings.findIndex(x => x.key === key)
      if (idx >= 0) this.appSettings.splice(idx, 1, data)
      else this.appSettings.push(data)
      this.newKey = ''
      this.newValue = ''
      this.showToast(`${key} 설정을 추가했습니다.`)
    },
    fmtDate(s) {
      return s ? new Date(s).toLocaleString('ko-KR') : ''
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
