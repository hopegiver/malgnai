<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h1 class="mb-0">사용자</h1>
      <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
        <i class="bi bi-person-plus me-1"></i>사용자 추가
      </button>
    </div>

    <div class="alert alert-light border py-2 small mb-3">
      <i class="bi bi-info-circle me-1"></i>
      콘솔에 로그인할 수 있는 사용자를 관리합니다. 비밀번호는 해시로만 저장되며 다시 볼 수 없습니다.
      2단계 인증(2FA)은 각 사용자가 <router-link to="/settings">설정</router-link>에서 직접 켭니다.
    </div>

    <div v-if="error" class="alert alert-danger d-flex justify-content-between align-items-center" role="alert">
      <span><i class="bi bi-exclamation-triangle me-2"></i>{{ error }}</span>
      <button type="button" class="btn btn-sm btn-outline-danger" @click="load">다시 시도</button>
    </div>
    <div v-if="toast" class="alert alert-info py-2" role="status"><i class="bi bi-info-circle me-2"></i>{{ toast }}</div>

    <div v-if="loading" class="text-muted py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중…</div>
    <div v-else-if="!users.length" class="text-center text-muted py-5">
      <i class="bi bi-people d-block mb-2" style="font-size: 2rem;"></i>등록된 사용자가 없습니다.
    </div>

    <div v-else class="card">
      <div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead>
            <tr class="text-faint small">
              <th>아이디</th><th>권한</th><th>2단계 인증</th><th>생성일</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td class="fw-semibold">
                {{ u.username }}
                <span v-if="isMe(u)" class="badge bg-light text-dark ms-1">나</span>
              </td>
              <td>
                <span class="badge" :class="u.role === 'admin' ? 'bg-primary' : 'bg-light text-dark'">
                  {{ u.role === 'admin' ? '관리자' : '일반' }}
                </span>
              </td>
              <td>
                <span class="badge" :class="u.totp_enabled ? 'bg-success' : 'bg-secondary'">
                  {{ u.totp_enabled ? '사용 중' : '꺼짐' }}
                </span>
              </td>
              <td class="small text-muted">{{ fmtDate(u.created_at) }}</td>
              <td class="text-end">
                <button type="button" class="btn btn-sm btn-link p-0 me-2" @click="openEdit(u)">수정</button>
                <button
                  type="button"
                  class="btn btn-sm btn-link text-danger p-0"
                  :disabled="isMe(u) || users.length <= 1"
                  @click="remove(u)"
                >삭제</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 추가/수정 모달 -->
    <div v-if="modal" class="users-modal-overlay" @click.self="modal = false">
      <div class="users-modal card p-4">
        <h5 class="mb-3">{{ form.id ? '사용자 수정' : '사용자 추가' }}</h5>

        <div class="mb-3">
          <label class="form-label small fw-medium">아이디</label>
          <input
            ref="usernameInput"
            class="form-control form-control-sm"
            v-model="form.username"
            type="text"
            autocomplete="off"
            placeholder="예: name@malgnsoft.com"
          >
        </div>

        <div class="mb-3">
          <label class="form-label small fw-medium">권한</label>
          <select class="form-select form-select-sm" v-model="form.role">
            <option value="user">일반 (모니터링만)</option>
            <option value="admin">관리자 (사용자 관리 가능)</option>
          </select>
        </div>

        <div class="mb-3">
          <label class="form-label small fw-medium">
            비밀번호
            <span v-if="form.id" class="text-muted fw-normal">(변경할 때만 입력)</span>
          </label>
          <input
            class="form-control form-control-sm"
            v-model="form.password"
            type="password"
            autocomplete="new-password"
            :placeholder="form.id ? '비워두면 기존 비밀번호 유지' : '8자 이상'"
          >
        </div>

        <div v-if="modalError" class="alert alert-danger py-2 small">{{ modalError }}</div>
        <div class="d-flex justify-content-end gap-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" @click="modal = false">취소</button>
          <button type="button" class="btn btn-sm btn-primary" :disabled="saving" @click="save">
            <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>저장
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: '사용자 · 맑은AI Monitor',
  data() {
    return {
      users: [],
      me: '',
      loading: false,
      error: '',
      toast: '',
      toastTimer: null,
      modal: false,
      modalError: '',
      saving: false,
      form: this.emptyForm(),
    }
  },
  async mounted() {
    // 관리자만 접근 가능(메뉴는 숨기지만 URL 직접 접근 방어). API 도 403 으로 막힌다.
    if (!isAdmin()) {
      this.$router.replace('/')
      return
    }
    await Promise.all([this.loadMe(), this.load()])
  },
  beforeUnmount() {
    clearTimeout(this.toastTimer)
  },
  methods: {
    emptyForm() {
      return { id: null, username: '', password: '', role: 'user' }
    },
    isMe(u) {
      return !!this.me && u.username === this.me
    },
    async loadMe() {
      const { data } = await useApi('/api/auth/me')
      this.me = data?.user?.username || ''
    },
    async load() {
      this.loading = true
      this.error = ''
      const { data, error } = await useApi('/api/users')
      this.loading = false
      if (error) { this.error = `사용자를 불러오지 못했습니다: ${error}`; this.users = []; return }
      this.users = data.users || []
    },
    openCreate() {
      this.form = this.emptyForm()
      this.modalError = ''
      this.modal = true
      this.$nextTick(() => this.$refs.usernameInput?.focus())
    },
    openEdit(u) {
      this.form = { id: u.id, username: u.username, password: '', role: u.role === 'admin' ? 'admin' : 'user' }
      this.modalError = ''
      this.modal = true
      this.$nextTick(() => this.$refs.usernameInput?.focus())
    },
    async save() {
      this.modalError = ''
      const username = (this.form.username || '').trim()
      if (!username) { this.modalError = '아이디를 입력하세요.'; return }
      if (!this.form.id && (this.form.password || '').length < 8) {
        this.modalError = '비밀번호는 최소 8자 이상이어야 합니다.'
        return
      }
      if (this.form.id && this.form.password && this.form.password.length < 8) {
        this.modalError = '비밀번호는 최소 8자 이상이어야 합니다.'
        return
      }

      this.saving = true
      const payload = { username, role: this.form.role }
      if (this.form.password) payload.password = this.form.password

      const url = this.form.id ? `/api/users/${this.form.id}` : '/api/users'
      const method = this.form.id ? 'PUT' : 'POST'
      const { error } = await useApi(url, { method, body: payload })
      this.saving = false
      if (error) { this.modalError = `저장 실패: ${error}`; return }
      this.modal = false
      this.showToast('저장되었습니다.')
      await this.load()
    },
    async remove(u) {
      if (!window.confirm(`사용자 '${u.username}' 을(를) 삭제할까요?`)) return
      const { error } = await useApi(`/api/users/${u.id}`, { method: 'DELETE' })
      if (error) { this.showToast(`삭제 실패: ${error}`); return }
      this.showToast('삭제되었습니다.')
      await this.load()
    },
    showToast(msg) {
      this.toast = msg
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toastTimer = setTimeout(() => { this.toast = '' }, 4000)
    },
    fmtDate(s) {
      if (!s) return '—'
      const d = new Date(s)
      if (isNaN(d)) return s
      return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
    },
  },
}
</script>

<style>
.users-modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 200; padding: 1rem;
}
.users-modal { width: 100%; max-width: 440px; max-height: 90vh; overflow-y: auto; }
</style>
