<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h1 class="mb-0">기능 요청</h1>
      <button type="button" class="btn btn-primary btn-sm" @click="openForm">
        <i class="bi bi-plus-lg me-1"></i>새 요청 작성
      </button>
    </div>

    <!-- 상태 필터 탭 -->
    <div class="btn-group btn-group-sm mb-3">
      <button v-for="f in filters" :key="f.value" type="button"
              class="btn" :class="statusFilter === f.value ? 'btn-primary' : 'btn-outline-secondary'"
              @click="setStatusFilter(f.value)">
        {{ f.label }}
      </button>
    </div>

    <!-- 일시 안내 -->
    <div v-if="toast" class="alert alert-info py-2 d-flex justify-content-between align-items-center" role="status">
      <span><i class="bi bi-info-circle me-2"></i>{{ toast }}</span>
      <button type="button" class="btn-close" aria-label="닫기" @click="toast = ''"></button>
    </div>

    <!-- API 에러 — 화면에 노출 -->
    <div v-if="error" class="alert alert-danger d-flex justify-content-between align-items-center" role="alert">
      <span><i class="bi bi-exclamation-triangle me-2"></i>{{ error }}</span>
      <button type="button" class="btn btn-sm btn-outline-danger" @click="load">다시 시도</button>
    </div>

    <div v-if="loading" class="text-muted py-4">불러오는 중…</div>
    <div v-else-if="!items.length" class="text-center text-muted py-5">
      <i class="bi bi-lightbulb d-block mb-2" style="font-size: 2rem;"></i>
      {{ statusFilter === 'all' ? '작성된 기능 요청이 없습니다.' : '해당 상태의 기능 요청이 없습니다.' }}
    </div>

    <div v-for="r in items" :key="r.id" class="card p-3 mb-3 border-start border-4" :class="statusBorder(r.status)">
      <div class="d-flex justify-content-between align-items-start mb-2">
        <div class="me-2 fw-bold">{{ r.title }}</div>
        <span :class="'badge bg-' + statusColor(r.status)">{{ statusLabel(r.status) }}</span>
      </div>

      <p v-if="r.description" class="mb-2 small" style="white-space: pre-wrap;">{{ r.description }}</p>

      <div v-if="r.review_reason" class="alert alert-light py-2 small mb-2">
        <i class="bi bi-chat-left-text me-1"></i>심사 사유: {{ r.review_reason }}
      </div>

      <div class="text-faint small">{{ fmt(r.created_at) }}</div>
    </div>

    <!-- 새 요청 작성 모달 -->
    <div v-if="formOpen" class="modal-backdrop-custom" @click.self="closeForm">
      <div class="card p-4" style="max-width:480px;width:100%" role="dialog" aria-modal="true" aria-labelledby="feature-request-form-title">
        <h5 id="feature-request-form-title" class="mb-3">새 기능 요청 작성</h5>

        <div v-if="submitError" class="alert alert-danger py-2 small">{{ submitError }}</div>
        <p class="text-muted small mb-3">malgnai 플랫폼 자체에 대한 기능 개선 요청입니다. AI가 심사 후 승인되면 다음 자율 사이클에 자동 반영됩니다.</p>

        <div class="mb-3">
          <label class="form-label small">제목</label>
          <input type="text" class="form-control" v-model="form.title" placeholder="요청 제목을 입력하세요" maxlength="200" />
        </div>
        <div class="mb-3">
          <label class="form-label small">설명</label>
          <textarea class="form-control" rows="5" v-model="form.description" placeholder="원하는 기능을 자세히 설명해주세요"></textarea>
        </div>

        <div class="d-flex justify-content-end gap-2">
          <button type="button" class="btn btn-outline-secondary" :disabled="submitting" @click="closeForm">취소</button>
          <button type="button" class="btn btn-primary" :disabled="submitting || !canSubmit" @click="submitForm">
            {{ submitting ? '제출 중…' : '요청 제출' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: '기능 요청',
  data() {
    return {
      items: [],
      loading: false,
      error: '',        // API 에러 메시지(화면 노출)
      toast: '',         // 일시 안내. alert 대신 인라인 배너.
      toastTimer: null,
      statusFilter: 'all',
      formOpen: false,
      submitting: false,
      submitError: '',
      form: { title: '', description: '' },
      filters: [
        { value: 'all', label: '전체' },
        { value: 'pending', label: '대기중' },
        { value: 'reviewing', label: '심사중' },
        { value: 'approved', label: '승인됨' },
        { value: 'rejected', label: '반려됨' },
      ],
    }
  },
  computed: {
    canSubmit() {
      return !!(this.form.title.trim() && this.form.description.trim())
    },
  },
  async mounted() {
    await this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.error = ''
      const q = this.statusFilter === 'all' ? '' : `?status=${this.statusFilter}`
      const { data, error } = await useApi(`/api/feature-requests${q}`)
      this.loading = false
      // data가 null인 경우(백엔드 미기동/라우트 없음 등으로 JSON 파싱 실패)도 에러로 취급 —
      // res.ok가 true인데 JSON이 아닌 응답(SPA 폴백 HTML 등)이 오면 error는 비어있을 수 있다.
      if (error || !data) {
        this.error = `목록을 불러오지 못했습니다: ${error || '알 수 없는 오류'}`
        this.items = []
        return
      }
      this.items = data.feature_requests || []
    },
    setStatusFilter(v) {
      this.statusFilter = v
      this.load()
    },
    openForm() {
      this.submitError = ''
      this.form = { title: '', description: '' }
      this.formOpen = true
    },
    closeForm() {
      if (this.submitting) return
      this.formOpen = false
    },
    async submitForm() {
      if (!this.canSubmit) return
      this.submitting = true
      this.submitError = ''
      const { error } = await useApi('/api/feature-requests', {
        method: 'POST',
        body: {
          title: this.form.title.trim(),
          description: this.form.description.trim(),
        },
      })
      this.submitting = false
      if (error) {
        this.submitError = `제출에 실패했습니다: ${error}`
        return
      }
      this.formOpen = false
      this.showToast('기능 요청을 제출했습니다.')
      await this.load()
    },
    // 인라인 토스트(배너). alert/confirm 지양. 4초 후 자동 소거.
    showToast(msg) {
      this.toast = msg
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toastTimer = setTimeout(() => { this.toast = '' }, 4000)
    },
    statusColor(s) {
      return { pending: 'secondary', reviewing: 'info', approved: 'success', rejected: 'danger' }[s] || 'secondary'
    },
    statusBorder(s) {
      return { pending: 'border-secondary', reviewing: 'border-info', approved: 'border-success', rejected: 'border-danger' }[s] || 'border-light'
    },
    statusLabel(s) {
      return { pending: '대기중', reviewing: '심사중', approved: '승인됨', rejected: '반려됨' }[s] || s
    },
    fmt(s) {
      return s ? new Date(s).toLocaleString('ko-KR') : ''
    },
  },
}
</script>
