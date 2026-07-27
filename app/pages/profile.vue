<template>
  <div>
    <h1 class="mb-4">프로필</h1>

    <div v-if="loading" class="card p-4 placeholder-glow" style="max-width:560px">
      <span class="placeholder col-4 mb-2" style="height:1.5rem"></span>
      <span class="placeholder col-6"></span>
    </div>

    <div v-else-if="loadError" class="alert alert-warning d-flex justify-content-between align-items-center" style="max-width:560px">
      <span><i class="bi bi-exclamation-triangle me-1"></i>{{ loadError }}</span>
      <button class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
    </div>

    <template v-else>
      <!-- 기본 정보 -->
      <div class="card p-4 mb-3" style="max-width:560px">
        <h2 class="h6 mb-3">기본 정보</h2>

        <div class="mb-3">
          <label class="form-label small fw-semibold">이메일</label>
          <input type="text" class="form-control" :value="user.email" disabled readonly />
        </div>

        <div class="mb-3">
          <label class="form-label small fw-semibold">역할</label>
          <div>
            <span class="badge" :class="userRoleMeta(user.role).cls">{{ userRoleMeta(user.role).label }}</span>
          </div>
        </div>

        <form @submit.prevent="saveName">
          <div class="mb-3">
            <label class="form-label small fw-semibold" for="profileName">이름</label>
            <input
              id="profileName"
              v-model="name"
              type="text"
              class="form-control"
              :disabled="nameSaving"
              placeholder="이름을 입력하세요"
            />
          </div>

          <div v-if="nameError" class="alert alert-danger py-2 small mb-3">{{ nameError }}</div>
          <div v-if="nameSuccess" class="alert alert-success py-2 small mb-3"><i class="bi bi-check-circle me-1"></i>이름이 변경되었습니다.</div>

          <button type="submit" class="btn btn-primary" :disabled="nameSaveDisabled">
            <span v-if="nameSaving" class="spinner-border spinner-border-sm me-2"></span>
            이름 저장
          </button>
        </form>
      </div>

      <!-- 비밀번호 변경 -->
      <div class="card p-4" style="max-width:560px">
        <h2 class="h6 mb-3">비밀번호 변경</h2>
        <p class="text-faint small mb-3">비밀번호를 변경하면 이 브라우저를 제외한 다른 모든 기기의 로그인 세션이 종료됩니다.</p>

        <form @submit.prevent="changePassword">
          <div class="mb-3">
            <label class="form-label small fw-semibold" for="pwCurrent">현재 비밀번호</label>
            <input id="pwCurrent" v-model="currentPassword" type="password" class="form-control" autocomplete="current-password" :disabled="pwSaving" />
          </div>
          <div class="mb-3">
            <label class="form-label small fw-semibold" for="pwNew">새 비밀번호</label>
            <input id="pwNew" v-model="newPassword" type="password" class="form-control" autocomplete="new-password" :disabled="pwSaving" placeholder="12자 이상" />
          </div>
          <div class="mb-3">
            <label class="form-label small fw-semibold" for="pwConfirm">새 비밀번호 확인</label>
            <input id="pwConfirm" v-model="confirmPassword" type="password" class="form-control" autocomplete="new-password" :disabled="pwSaving" />
          </div>

          <div v-if="pwError" class="alert alert-danger py-2 small mb-3">{{ pwError }}</div>
          <div v-if="pwSuccess" class="alert alert-success py-2 small mb-3">
            <i class="bi bi-check-circle me-1"></i>비밀번호가 변경되었습니다. 다른 기기는 로그아웃됩니다.
          </div>

          <button type="submit" class="btn btn-primary" :disabled="pwSaveDisabled">
            <span v-if="pwSaving" class="spinner-border spinner-border-sm me-2"></span>
            비밀번호 변경
          </button>
        </form>
      </div>
    </template>
  </div>
</template>

<script>
export default {
  title: '프로필 · malgnai-hub',
  data() {
    return {
      user: null,
      loading: true,
      loadError: '',

      name: '',
      nameSaving: false,
      nameError: '',
      nameSuccess: false,

      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
      pwSaving: false,
      pwError: '',
      pwSuccess: false,
    }
  },
  computed: {
    nameSaveDisabled() {
      return this.nameSaving || !this.name.trim() || this.name.trim() === this.user?.name
    },
    pwSaveDisabled() {
      return this.pwSaving || !this.currentPassword || !this.newPassword || !this.confirmPassword
    },
  },
  async mounted() {
    await this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.loadError = ''
      const user = await getCurrentUser(true)
      this.loading = false
      if (!user) {
        this.loadError = '프로필 정보를 불러오지 못했습니다.'
        return
      }
      this.user = user
      this.name = user.name || ''
    },
    async saveName() {
      this.nameSaving = true
      this.nameError = ''
      this.nameSuccess = false
      const { data, error } = await useApi('/api/auth/me', {
        method: 'PATCH',
        body: { name: this.name.trim() },
      })
      this.nameSaving = false
      if (error) {
        this.nameError = error?.message || '이름 변경에 실패했습니다.'
        return
      }
      this.nameSuccess = true
      // 캐시 무효화 — 다음 getCurrentUser() 호출(레이아웃 재진입 등)이 새 이름을 반영하도록.
      const updated = await getCurrentUser(true)
      if (updated) this.user = updated
    },
    async changePassword() {
      this.pwError = ''
      this.pwSuccess = false
      if (this.newPassword.length < 12) {
        this.pwError = '새 비밀번호는 12자 이상이어야 합니다.'
        return
      }
      if (this.newPassword !== this.confirmPassword) {
        this.pwError = '새 비밀번호가 일치하지 않습니다.'
        return
      }
      this.pwSaving = true
      const { data, error } = await useApi('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword: this.currentPassword, newPassword: this.newPassword },
      })
      this.pwSaving = false
      if (error) {
        this.pwError = error?.message || '비밀번호 변경에 실패했습니다.'
        return
      }
      this.pwSuccess = true
      this.currentPassword = ''
      this.newPassword = ''
      this.confirmPassword = ''
    },
    userRoleMeta,
  },
}
</script>
