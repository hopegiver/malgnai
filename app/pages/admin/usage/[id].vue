<template>
  <div>
    <div v-if="!guardReady"></div>

    <template v-else-if="!allowed">
      <div class="alert alert-warning"><i class="bi bi-shield-lock me-1"></i>관리자만 접근할 수 있는 화면입니다.</div>
    </template>

    <template v-else>
      <div class="mb-3">
        <router-link to="/admin/usage" class="text-muted small"><i class="bi bi-arrow-left me-1"></i>사용량 통계</router-link>
      </div>

      <!-- 사용자 로딩/에러 -->
      <div v-if="loading" class="card p-4 placeholder-glow mb-3">
        <span class="placeholder col-4 mb-2" style="height:1.5rem"></span>
        <span class="placeholder col-6"></span>
      </div>
      <div v-else-if="error" class="alert alert-warning d-flex justify-content-between align-items-center">
        <span><i class="bi bi-exclamation-triangle me-1"></i>{{ errorMessage }}</span>
        <button v-if="errorCode !== 'NOT_FOUND'" class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
      </div>

      <template v-else>
        <div class="d-flex justify-content-between align-items-start mb-4 flex-wrap gap-2">
          <div>
            <h1 class="mb-1">{{ user.name || user.email }}</h1>
            <div class="text-muted small">
              <span>{{ user.email }}</span>
              <span class="badge ms-2" :class="userRoleMeta(user.role).cls">{{ userRoleMeta(user.role).label }}</span>
              <span class="badge ms-1" :class="userStatusMeta(user.status).cls">{{ userStatusMeta(user.status).label }}</span>
            </div>
          </div>
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <UsagePeriodPreset v-model="presetKey" :disabled="dataLoading" @change="onPeriodChange" />
            <button class="btn btn-sm btn-outline-secondary" @click="loadData" :disabled="dataLoading" title="새로고침">
              <i class="bi" :class="dataLoading ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'"></i>
            </button>
          </div>
        </div>

        <div v-if="dataLoading" class="row g-3 mb-4">
          <div class="col-6 col-lg-3" v-for="n in 4" :key="n">
            <div class="card p-3 placeholder-glow"><span class="placeholder col-7 mb-2"></span><span class="placeholder col-4" style="height:1.75rem"></span></div>
          </div>
        </div>

        <div v-else-if="dataError" class="alert alert-warning d-flex justify-content-between align-items-center">
          <span><i class="bi bi-exclamation-triangle me-1"></i>{{ dataErrorMessage }}</span>
          <button class="btn btn-sm btn-outline-secondary" @click="loadData">다시 시도</button>
        </div>

        <template v-else>
          <!-- 빈 상태: 선택 기간에 사용량 없음 -->
          <div v-if="!dailyRows.length && !sessions.length" class="text-center py-5">
            <i class="bi bi-bar-chart d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
            <div class="fw-medium mb-1 text-muted">선택 기간에 사용량 데이터가 없습니다</div>
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
                  <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-calendar-check"></i></span><span class="pd-stat-label">활동일</span></div>
                  <div class="pd-stat-value">{{ dailyRows.length }}</div>
                  <div class="pd-stat-sub">일</div>
                </div>
              </div>
            </div>

            <!-- 일별 토큰 사용량 바 그래프 -->
            <div class="card p-4 mb-3" v-if="chartData.length">
              <div class="d-flex justify-content-between align-items-center mb-3">
                <h2 class="h6 mb-0">일별 토큰 사용량</h2>
                <span class="text-faint small">최근 {{ chartData.length }}일</span>
              </div>
              <div class="usage-chart">
                <div class="usage-chart-bars">
                  <div
                    v-for="d in chartData"
                    :key="d.day"
                    class="usage-chart-col"
                    :title="`${d.day} · ${formatTokens(d.tokens)} 토큰`"
                  >
                    <span class="usage-chart-value">{{ formatTokens(d.tokens) }}</span>
                    <div class="usage-chart-bar" :style="{ height: d.barPx + 'px' }"></div>
                  </div>
                </div>
                <div class="usage-chart-axis">
                  <span v-for="d in chartData" :key="d.day" class="usage-chart-label">{{ d.shortDay }}</span>
                </div>
              </div>
            </div>

            <!-- 일별 집계 (usage_daily엔 model 컬럼이 없어 표시하지 않는다) -->
            <div class="card p-4 mb-3" v-if="dailyRows.length">
              <h2 class="h6 mb-3">일별 사용량</h2>
              <div class="table-responsive">
                <table class="table table-sm mb-0">
                  <thead><tr><th>날짜</th><th class="text-end">세션</th><th class="text-end">입력</th><th class="text-end">출력</th><th class="text-end">캐시읽기</th><th class="text-end">도구</th><th class="text-end">도구오류</th><th class="text-end">턴</th><th class="text-end">API호출</th></tr></thead>
                  <tbody>
                    <tr v-for="row in dailyRows" :key="row.day_at">
                      <td>{{ row.day_at }}</td>
                      <td class="text-end">{{ row.session_count }}</td>
                      <td class="text-end">{{ formatTokens(row.input_tokens) }}</td>
                      <td class="text-end">{{ formatTokens(row.output_tokens) }}</td>
                      <td class="text-end">{{ formatTokens(row.cache_read_tokens) }}</td>
                      <td class="text-end">{{ row.tool_calls }}</td>
                      <td class="text-end">{{ row.tool_errors }}</td>
                      <td class="text-end">{{ row.turns }}</td>
                      <td class="text-end">{{ row.api_calls }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 최근 세션 (GET /api/usage/sessions?user_id= 재사용) -->
            <div class="card p-4">
              <h2 class="h6 mb-3">최근 세션</h2>
              <div v-if="sessionsError" class="alert alert-warning py-2 small mb-0 d-flex justify-content-between align-items-center">
                <span><i class="bi bi-exclamation-triangle me-1"></i>세션 목록을 불러오지 못했습니다.</span>
                <button class="btn btn-sm btn-outline-secondary" @click="loadSessions">다시 시도</button>
              </div>
              <div v-else-if="sessions.length" class="pd-list">
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
      </template>
    </template>
  </div>
</template>

<script>
export default {
  title: '사용자별 사용량 · malgnai-hub',
  data() {
    const initial = usagePeriodRange('30d')
    return {
      guardReady: false,
      allowed: false,

      loading: true,
      error: false,
      errorMessage: '',
      errorCode: '',
      user: null,

      presetKey: '30d',
      from: initial.from,
      to: initial.to,

      dataLoading: true,
      dataError: false,
      dataErrorMessage: '',
      dailyRows: [],
      sessions: [],
      sessionsError: false,
    }
  },
  computed: {
    totals() {
      const t = { sessions: 0, tokens: 0, toolCalls: 0, toolErrors: 0 }
      for (const r of this.dailyRows) {
        t.sessions += r.session_count || 0
        t.tokens += (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0)
        t.toolCalls += r.tool_calls || 0
        t.toolErrors += r.tool_errors || 0
      }
      return t
    },
    chartData() {
      const rows = this.dailyRows.map((r) => ({
        day: r.day_at,
        tokens: (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0),
      }))
      const max = Math.max(1, ...rows.map((r) => r.tokens))
      const maxBarPx = 140
      return rows.map((r) => ({
        ...r,
        barPx: Math.max(2, Math.round((r.tokens / max) * maxBarPx)),
        shortDay: r.day.slice(5),
      }))
    },
  },
  async mounted() {
    const me = await getCurrentUser()
    this.allowed = me?.role === 'administrator'
    this.guardReady = true
    if (!this.allowed) {
      this.$router.replace('/')
      return
    }
    await this.load()
  },
  methods: {
    // GET /api/admin/usage/users/:id 한 번으로 user + 일별 data를 함께 받는다(docs/api.md §5.8.2).
    async load() {
      this.loading = true
      this.error = false
      const id = this.$route.params.id
      const { data, error } = await useApi(`/api/admin/usage/users/${id}?from=${this.from}&to=${this.to}`)
      this.loading = false
      if (error) {
        this.error = true
        this.errorCode = error?.code || ''
        this.errorMessage = error?.code === 'NOT_FOUND' ? '사용자를 찾을 수 없습니다.' : (error?.message || '사용자 사용량을 불러오지 못했습니다.')
        return
      }
      this.user = data?.user ?? null
      this.dailyRows = data?.data || []
      this.dataLoading = false
      await this.loadSessions()
    },
    // 기간만 바뀐 재조회 — 사용자 정보(user)는 다시 받을 필요 없지만 API가 같은 라우트로 함께
    // 내려주므로 그대로 재호출하고 user도 최신값으로 갱신한다(role/status가 그 사이 바뀌었을 수 있음).
    async loadData() {
      this.dataLoading = true
      this.dataError = false
      const id = this.$route.params.id
      const { data, error } = await useApi(`/api/admin/usage/users/${id}?from=${this.from}&to=${this.to}`)
      this.dataLoading = false
      if (error) {
        this.dataError = true
        this.dataErrorMessage = error?.message || '사용자 사용량을 불러오지 못했습니다.'
        return
      }
      this.user = data?.user ?? this.user
      this.dailyRows = data?.data || []
      await this.loadSessions()
    },
    // administrator는 user_id 쿼리로 타인 세션을 볼 수 있다(docs/api.md §5.5).
    async loadSessions() {
      const id = this.$route.params.id
      const { data, error } = await useApi(`/api/usage/sessions?user_id=${id}&limit=20`)
      // 실패를 "세션 없음"과 구분해 보여준다(M-3와 동종 패턴 — 조용한 빈 화면 방지).
      if (error) { this.sessions = []; this.sessionsError = true; return }
      this.sessionsError = false
      this.sessions = data?.data || []
    },
    onPeriodChange(range) {
      this.from = range.from
      this.to = range.to
      this.loadData()
    },
    formatTokens,
    formatDate,
    userRoleMeta,
    userStatusMeta,
  },
}
</script>
