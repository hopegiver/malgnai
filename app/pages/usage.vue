<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
      <h1 class="mb-0">사용량</h1>
      <div class="d-flex align-items-center gap-2">
        <input type="date" class="form-control form-control-sm" v-model="from" :max="to" style="width:auto">
        <span class="text-faint small">~</span>
        <input type="date" class="form-control form-control-sm" v-model="to" :min="from" :max="today" style="width:auto">
        <button class="btn btn-sm btn-outline-secondary" @click="load" :disabled="loading">
          <i class="bi" :class="loading ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'"></i>
        </button>
      </div>
    </div>

    <div v-if="loading" class="row g-3 mb-4">
      <div class="col-6 col-lg-3" v-for="n in 4" :key="n">
        <div class="card p-3 placeholder-glow"><span class="placeholder col-7 mb-2"></span><span class="placeholder col-4" style="height:1.75rem"></span></div>
      </div>
    </div>

    <div v-else-if="error" class="alert alert-warning d-flex justify-content-between align-items-center">
      <span><i class="bi bi-exclamation-triangle me-1"></i>{{ errorMessage }}</span>
      <button class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
    </div>

    <template v-else>
      <!-- 빈 상태: 아직 2단계 데이터 없음 -->
      <div v-if="!dailyRows.length && !sessions.length" class="text-center py-5">
        <i class="bi bi-bar-chart d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
        <div class="fw-medium mb-1 text-muted">아직 사용량 데이터가 없습니다</div>
        <div class="text-faint small">Claude Code 세션이 OTel Collector를 통해 집계되면 이곳에 표시됩니다.</div>
      </div>

      <template v-else>
        <!-- KPI 4종 -->
        <div class="row g-3 mb-4">
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--primary p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-broadcast"></i></span><span class="pd-stat-label">세션</span></div>
              <div class="pd-stat-value">{{ totals.sessions }}</div>
              <div class="pd-stat-sub">선택 기간</div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--info p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-coin"></i></span><span class="pd-stat-label">총 토큰</span></div>
              <div class="pd-stat-value">{{ formatTokens(totals.tokens) }}</div>
              <div class="pd-stat-sub">입력+출력+캐시</div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--success p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-tools"></i></span><span class="pd-stat-label">도구 호출</span></div>
              <div class="pd-stat-value">{{ formatTokens(totals.toolCalls) }}</div>
              <div class="pd-stat-sub">오류 {{ totals.toolErrors }}건</div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--neutral p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-cpu"></i></span><span class="pd-stat-label">모델</span></div>
              <div class="pd-stat-value" style="font-size:var(--font-size-lg)">{{ totals.modelCount }}종</div>
              <div class="pd-stat-sub">사용됨</div>
            </div>
          </div>
        </div>

        <!-- 모델별 일별 집계 -->
        <div class="card p-4 mb-3" v-if="dailyRows.length">
          <h2 class="h6 mb-3">일별·모델별 사용량</h2>
          <div class="table-responsive">
            <table class="table table-sm mb-0">
              <thead><tr><th>날짜</th><th>모델</th><th class="text-end">세션</th><th class="text-end">입력</th><th class="text-end">출력</th><th class="text-end">캐시읽기</th><th class="text-end">도구</th></tr></thead>
              <tbody>
                <tr v-for="row in dailyRows" :key="row.day_at + row.model">
                  <td>{{ row.day_at }}</td>
                  <td><span class="badge bg-light text-dark">{{ row.model || '미상' }}</span></td>
                  <td class="text-end">{{ row.session_count }}</td>
                  <td class="text-end">{{ formatTokens(row.input_tokens) }}</td>
                  <td class="text-end">{{ formatTokens(row.output_tokens) }}</td>
                  <td class="text-end">{{ formatTokens(row.cache_read_tokens) }}</td>
                  <td class="text-end">{{ row.tool_calls }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 최근 세션 -->
        <div class="card p-4">
          <h2 class="h6 mb-3">최근 세션</h2>
          <div v-if="sessions.length" class="pd-list">
            <div v-for="s in sessions" :key="s.id" class="pd-item pd-item--static">
              <div class="pd-item-body">
                <div class="d-flex align-items-center gap-2 mb-1">
                  <span class="pd-item-title">{{ s.summary || s.claude_session_id }}</span>
                  <span v-if="s.model" class="badge bg-light text-dark">{{ s.model }}</span>
                </div>
                <div class="pd-item-meta d-flex flex-wrap gap-3">
                  <span>토큰 {{ formatTokens((s.input_tokens || 0) + (s.output_tokens || 0)) }}</span>
                  <span v-if="s.duration_seconds">{{ Math.round(s.duration_seconds / 60) }}분</span>
                  <span v-if="s.tool_calls">도구 {{ s.tool_calls }}</span>
                  <span v-if="s.files_changed">파일 {{ s.files_changed }}</span>
                </div>
              </div>
              <div class="pd-item-right"><small class="text-faint text-nowrap">{{ formatDate(s.started_at) }}</small></div>
            </div>
          </div>
          <p v-else class="text-muted mb-0 small">선택 기간에 동기화된 세션이 없습니다.</p>
        </div>
      </template>
    </template>
  </div>
</template>

<script>
function isoDaysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default {
  title: '사용량 · malgnai-hub',
  data() {
    return {
      today: isoDaysAgo(0),
      from: isoDaysAgo(30),
      to: isoDaysAgo(0),
      loading: true,
      error: false,
      errorMessage: '',
      dailyRows: [],
      sessions: [],
    }
  },
  computed: {
    totals() {
      const t = { sessions: 0, tokens: 0, toolCalls: 0, toolErrors: 0 }
      const models = new Set()
      for (const r of this.dailyRows) {
        t.sessions += r.session_count || 0
        t.tokens += (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0)
        t.toolCalls += r.tool_calls || 0
        t.toolErrors += r.tool_errors || 0
        if (r.model) models.add(r.model)
      }
      return { ...t, modelCount: models.size || 1 }
    },
  },
  async mounted() {
    await this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.error = false
      const [usageRes, sessionsRes] = await Promise.all([
        useApi(`/api/usage/me?from=${this.from}&to=${this.to}`),
        useApi('/api/usage/sessions?limit=20'),
      ])
      this.loading = false
      if (usageRes.error && sessionsRes.error) {
        this.error = true
        this.errorMessage = usageRes.error?.message || '사용량 데이터를 불러오지 못했습니다.'
        return
      }
      this.dailyRows = usageRes.data?.data || []
      this.sessions = sessionsRes.data?.data || []
    },
    formatTokens,
    formatDate,
  },
}
</script>
