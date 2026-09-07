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
        <button v-if="errorCode !== 'NOT_FOUND' && errorRetryable" class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
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
            <!-- m-3: index.vue에는 있던 출처·최신성 표기가 드릴다운에는 없었다 — 관리자가 개인별
                 숫자를 예전 값과 비교하는 자리가 바로 여기다. -->
            <div class="text-faint small">
              출처: 사내 Prometheus(OTel) 실측치 — 자체수집 값과 다를 수 있습니다
              <span v-if="meta && meta.fetched_at"> · 조회 시각 {{ formatDate(meta.fetched_at) }}</span>
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
          <button v-if="dataErrorRetryable" class="btn btn-sm btn-outline-secondary" @click="loadData">다시 시도</button>
        </div>

        <template v-else>
          <div v-if="meta && meta.window_clamped" class="alert alert-secondary py-2 small mb-3">
            <i class="bi bi-info-circle me-1"></i>수집 시작일({{ meta.data_start }}) 이전 구간은 데이터가 없습니다.
          </div>

          <div v-if="meta && meta.stale" class="alert alert-warning py-2 small mb-3">
            <i class="bi bi-info-circle me-1"></i>최신 데이터를 가져오지 못해 {{ (meta.cache && meta.cache.age_seconds) || 0 }}초 전 데이터를 표시 중입니다.
          </div>

          <div v-if="meta && meta.user_not_in_metrics" class="alert alert-info py-2 small mb-3">
            <i class="bi bi-info-circle me-1"></i>이 사용자는 선택 기간에 Prometheus 계측 데이터가 없습니다(신규 사용자이거나 아직 사용 이력이 없을 수 있습니다).
          </div>

          <!-- 빈 상태: 선택 기간에 Prometheus 사용량 없음. 세션 카드는 기간 무관 자체수집 데이터라
               이 판단(그리고 이 안에 있던 시절)에서 뺐다(M-5 — 세션 유무가 "선택 기간에 사용량이
               없다"는 문장의 진위를 좌우하면 안 된다). -->
          <div v-if="!dailyRows.length" class="text-center py-5">
            <i class="bi bi-bar-chart d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
            <div class="fw-medium mb-1 text-muted">선택 기간에 사용량 데이터가 없습니다</div>
          </div>

          <template v-else>
            <!-- KPI 4종 -->
            <div class="row g-3 mb-4">
              <div class="col-6 col-lg-3">
                <div class="card pd-stat pd-stat--primary p-3">
                  <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-broadcast"></i></span><span class="pd-stat-label">세션</span></div>
                  <div class="pd-stat-value">{{ totals.session_count }}</div>
                  <div class="pd-stat-sub">선택 기간</div>
                </div>
              </div>
              <div class="col-6 col-lg-3">
                <div class="card pd-stat pd-stat--info p-3">
                  <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-coin"></i></span><span class="pd-stat-label">총 토큰</span></div>
                  <div class="pd-stat-value">{{ formatTokens(totals.total_tokens) }}</div>
                  <div class="pd-stat-sub">입력+출력+캐시</div>
                </div>
              </div>
              <div class="col-6 col-lg-3">
                <div class="card pd-stat pd-stat--success p-3">
                  <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-cash-coin"></i></span><span class="pd-stat-label">추정 비용</span></div>
                  <div class="pd-stat-value">{{ formatCost(totals.cost_usd) }}</div>
                  <div class="pd-stat-sub">선택 기간(USD)</div>
                </div>
              </div>
              <div class="col-6 col-lg-3">
                <div class="card pd-stat pd-stat--neutral p-3">
                  <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-calendar-check"></i></span><span class="pd-stat-label">활동일</span></div>
                  <div class="pd-stat-value">{{ totals.active_days }}</div>
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

            <!-- 일별 집계. tool_calls/tool_errors/turns/api_calls는 이 Prometheus에 대응 메트릭이
                 없어 항상 null이라 컬럼 자체를 제거했다(0건으로 보이면 "오류 0건"이라는 거짓 표시가
                 된다 — docs/design/usage-prometheus-realtime.md §12.1). -->
            <div class="card p-4 mb-3" v-if="dailyRows.length">
              <h2 class="h6 mb-1">일별 사용량</h2>
              <!-- m-4: index.vue(140행)에는 있던 "0건이 아니라 측정 불가" 각주가 드릴다운에는 코드
                   주석에만 있고 화면에 없었다 — 주석은 관리자가 못 읽는다. -->
              <small class="text-faint d-block mb-2">도구 호출/턴/API 호출 지표는 Prometheus가 아직 제공하지 않아 표에서 제외했습니다(0건이 아니라 측정 불가).</small>
              <div class="table-responsive">
                <table class="table table-sm mb-0">
                  <thead><tr><th>날짜</th><th class="text-end">세션</th><th class="text-end">입력</th><th class="text-end">출력</th><th class="text-end">캐시읽기</th><th class="text-end">비용</th></tr></thead>
                  <tbody>
                    <tr v-for="row in dailyRows" :key="row.day_at">
                      <td>{{ row.day_at }}</td>
                      <td class="text-end">{{ row.session_count }}</td>
                      <td class="text-end">{{ formatTokens(row.input_tokens) }}</td>
                      <td class="text-end">{{ formatTokens(row.output_tokens) }}</td>
                      <td class="text-end">{{ formatTokens(row.cache_read_tokens) }}</td>
                      <td class="text-end">{{ formatCost(row.cost_usd) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 모델별 사용량(by_model, §5.3·§8) — usage_daily 시절엔 model 컬럼이 없어 항상
                 "미상"으로만 표시되던 이슈를 이 응답으로 해소한다. -->
            <div class="card p-4 mb-3" v-if="byModel.length">
              <h2 class="h6 mb-3">모델별 사용량</h2>
              <div class="table-responsive">
                <table class="table table-sm mb-0">
                  <thead><tr><th>모델</th><th class="text-end">입력</th><th class="text-end">출력</th><th class="text-end">캐시읽기</th><th class="text-end">캐시쓰기</th><th class="text-end">총 토큰</th><th class="text-end">비용</th></tr></thead>
                  <tbody>
                    <tr v-for="m in byModel" :key="m.model">
                      <td><span class="badge bg-light text-dark">{{ m.model }}</span></td>
                      <td class="text-end">{{ formatTokens(m.input_tokens) }}</td>
                      <td class="text-end">{{ formatTokens(m.output_tokens) }}</td>
                      <td class="text-end">{{ formatTokens(m.cache_read_tokens) }}</td>
                      <td class="text-end">{{ formatTokens(m.cache_write_tokens) }}</td>
                      <td class="text-end">{{ formatTokens(m.total_tokens) }}</td>
                      <td class="text-end">{{ formatCost(m.cost_usd) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </template>

          <!-- 최근 세션 (GET /api/usage/sessions?user_id= 재사용) — 위 KPI/차트/표는 전부 Prometheus
               기간 합산인 반면 이 카드는 D1 자체수집(sessions)이고 이 API는 from/to를 받지 않아
               기간과 무관하게 최근 N건을 돌려준다(server/api/usage.js:162-180, 이번 위임 범위 밖이라
               서버는 고치지 않음). "선택 기간에" 라벨을 붙이면 실제 쿼리와 다른 거짓 한정이 되므로
               문구에서 기간 한정을 빼고 출처 배지로 구분한다(M-5). dailyRows 유무와 무관하게 항상
               렌더한다 — 위 빈 상태 배너의 "선택 기간에 없음" 판단에도 더 이상 관여하지 않는다. -->
          <div class="card p-4 mt-3">
            <div class="d-flex align-items-center gap-2 mb-3">
              <h2 class="h6 mb-0">최근 세션</h2>
              <span class="badge bg-light text-dark" title="이 카드만 D1 자체수집(세션 동기화) 데이터입니다 — 위 지표(Prometheus)와 출처가 다릅니다">출처: 자체수집 · 기간 무관</span>
            </div>
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
            <p v-else class="text-muted mb-0 small">최근 동기화된 세션이 없습니다.</p>
          </div>
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
      errorRetryable: true,
      errorCode: '',
      user: null,

      presetKey: '30d',
      from: initial.from,
      to: initial.to,

      dataLoading: true,
      dataError: false,
      dataErrorMessage: '',
      dataErrorRetryable: true,
      dailyRows: [],
      // 서버가 기간 합계를 직접 계산해 내려준다(§5.3 totals) — 클라이언트에서 dailyRows를 다시
      // 합산하지 않는다(activity_days는 gap_days를 세지 않는 서버쪽 정의를 그대로 따라야 정확하다).
      totals: { session_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost_usd: 0, active_time_seconds: 0, active_days: 0 },
      byModel: [],
      meta: null,
      sessions: [],
      sessionsError: false,
    }
  },
  computed: {
    // 드릴다운은 전 구간 라이브라 gap_days 개념이 없다(§5.0 "이 라우트는 항상 gap_days: []") — 이
    // 라우트가 응답하는 모든 날은 실제로 상류에 질의된 날이므로, 그 날 행이 없다는 것은 "결손"이
    // 아니라 "그 날 총 토큰이 0이었다"는 뜻이다(§4.6-4의 0채움 규칙 그대로).
    // m-2: 예전에는 dailyRows를 그대로 축으로 써서 무활동일에 상류가 포인트를 안 주면 그 날이
    // 축에서 통째로 사라져(=압축) "최근 N일" 라벨이 선택 기간이 아니라 행 수를 가리켰다.
    // index.vue와 같은 enumerateUsageDays(meta.from~to)로 축을 스스로 채워 그 문제를 없앤다.
    chartData() {
      if (!this.meta || !this.meta.from || !this.meta.to) {
        // meta가 아직 없으면(로딩 중 등) 예전처럼 dailyRows만으로 폴백 — 화면이 비지 않게.
        const rows = this.dailyRows.map((r) => ({ day: r.day_at, tokens: r.total_tokens }))
        return rows.map((r) => ({ ...r, barPx: 2, shortDay: r.day.slice(5) }))
      }
      const byDay = new Map(this.dailyRows.map((r) => [r.day_at, r]))
      const rows = enumerateUsageDays(this.meta.from, this.meta.to).map((day) => {
        const row = byDay.get(day)
        return { day, tokens: row ? row.total_tokens : 0 }
      })
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
        if (error?.code === 'NOT_FOUND') {
          this.errorMessage = '사용자를 찾을 수 없습니다.'
          this.errorRetryable = false
        } else {
          // M-4: 503 UPSTREAM_UNAVAILABLE의 details.reason별 안내(not_configured 등은 재시도해도
          // 영원히 안 고쳐지므로 "잠시 후 다시 시도"를 쓰지 않는다).
          const info = usageErrorMessage(error)
          this.errorMessage = info.message
          this.errorRetryable = info.retryable
        }
        return
      }
      this.user = data?.user ?? null
      this.dailyRows = data?.data || []
      this.totals = data?.totals || this.totals
      this.byModel = data?.by_model || []
      this.meta = data?.meta || null
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
        const info = usageErrorMessage(error)
        this.dataErrorMessage = info.message
        this.dataErrorRetryable = info.retryable
        return
      }
      this.user = data?.user ?? this.user
      this.dailyRows = data?.data || []
      this.totals = data?.totals || this.totals
      this.byModel = data?.by_model || []
      this.meta = data?.meta || null
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
    formatCost,
    formatDate,
    userRoleMeta,
    userStatusMeta,
  },
}
</script>
