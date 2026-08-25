<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-4">
      <h1 class="mb-0">세션이력</h1>
      <button class="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1" @click="load()" :disabled="loading">
        <i class="bi" :class="loading ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'"></i>
        새로고침
      </button>
    </div>

    <div v-if="loading" class="card p-4">
      <div v-for="n in 5" :key="n" class="placeholder-glow mb-3">
        <span class="placeholder col-6 mb-2"></span><br>
        <span class="placeholder col-3"></span>
      </div>
    </div>

    <div v-else-if="error" class="alert alert-warning d-flex justify-content-between align-items-center">
      <span><i class="bi bi-exclamation-triangle me-1"></i>{{ errorMessage }}</span>
      <button class="btn btn-sm btn-outline-secondary" @click="load()">다시 시도</button>
    </div>

    <div v-else class="card p-4">
      <div v-if="sessions.length" class="pd-list">
        <div v-for="s in sessions" :key="s.id" class="pd-item pd-item--static">
          <div class="pd-item-body">
            <div class="d-flex align-items-center gap-2 mb-1">
              <span class="pd-item-title">{{ s.summary || s.claude_session_id }}</span>
              <span v-if="s.model" class="badge bg-light text-dark">{{ s.model }}</span>
            </div>
            <div class="pd-item-meta d-flex flex-wrap gap-3">
              <span v-if="s.project_name"><i class="bi bi-folder2 me-1"></i>{{ s.project_name }}</span>
              <span>토큰 {{ formatTokens((s.input_tokens || 0) + (s.output_tokens || 0)) }}</span>
              <span v-if="s.duration_seconds">{{ Math.round(s.duration_seconds / 60) }}분</span>
              <span v-if="s.tool_calls">도구 {{ s.tool_calls }}</span>
              <span v-if="s.files_changed">파일 {{ s.files_changed }}</span>
            </div>
          </div>
          <div class="pd-item-right"><small class="text-faint text-nowrap">{{ formatDate(s.started_at) }}</small></div>
        </div>
      </div>
      <div v-else class="text-center py-5">
        <i class="bi bi-broadcast d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
        <div class="fw-medium mb-1 text-muted">아직 동기화된 세션이 없습니다</div>
        <div class="text-faint small">Claude Code 세션이 OTel Collector를 통해 집계되면 이곳에 표시됩니다.</div>
      </div>

      <!-- 무한스크롤 트리거 -->
      <div ref="sentinel" style="height:1px"></div>
      <div v-if="loadingMore" class="text-center text-faint small py-2">불러오는 중…</div>
    </div>
  </div>
</template>

<script>
export default {
  title: '세션이력 · malgnai-hub',
  data() {
    return {
      sessions: [],
      nextCursor: null,
      loading: true,
      loadingMore: false,
      error: false,
      errorMessage: '',
    }
  },
  async mounted() {
    await this.load()
  },
  beforeUnmount() {
    if (this._observer) {
      this._observer.disconnect()
      this._observer = null
    }
  },
  methods: {
    async load(more = false) {
      if (more) {
        if (this.loadingMore || !this.nextCursor) return
        this.loadingMore = true
      } else {
        this.loading = true
        this.error = false
        this.sessions = []
        this.nextCursor = null
      }
      const params = new URLSearchParams({ limit: '20' })
      if (more && this.nextCursor) params.set('cursor', this.nextCursor)
      const { data, error } = await useApi(`/api/usage/sessions?${params.toString()}`)
      this.loading = false
      this.loadingMore = false
      if (error) {
        this.error = true
        this.errorMessage = error?.message || '세션이력을 불러오지 못했습니다.'
        return
      }
      const page = data?.data || []
      this.sessions = more ? [...this.sessions, ...page] : page
      this.nextCursor = data?.next_cursor ?? null
      this.$nextTick(() => this.setupObserver())
    },
    // projects/[id].vue의 무한스크롤 옵저버 패턴 재사용 — 더 없으면(nextCursor null) 설치하지 않는다.
    setupObserver() {
      if (this._observer) {
        this._observer.disconnect()
        this._observer = null
      }
      if (!this.nextCursor || !this.$refs.sentinel) return
      this._observer = new IntersectionObserver(
        (entries) => { if (entries.some((e) => e.isIntersecting)) this.load(true) },
        { rootMargin: '200px 0px', threshold: 0 }
      )
      this._observer.observe(this.$refs.sentinel)
    },
    formatTokens,
    formatDate,
  },
}
</script>
