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
      <!-- 세 가지 "빈 결과" 문구 분기(docs/design/usage-employee-identity-linking.md §4.5) — "고장"과
           "사용 안 함"을 구별한다. dailyRows/chartData 계산 로직은 건드리지 않고 이 배너만 얹는다. -->
      <div v-if="identityMessage" class="alert py-2 small mb-3" :class="identityAlertClass">
        <i class="bi" :class="meta && (meta.identity_unlinked || meta.identity_invalid) ? 'bi-exclamation-triangle me-1' : 'bi-info-circle me-1'"></i>{{ identityMessage }}
      </div>

      <!-- 빈 상태: 아직 2단계 데이터 없음 -->
      <div v-if="!dailyRows.length && !sessions.length" class="text-center py-5">
        <i class="bi bi-bar-chart d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
        <div class="fw-medium mb-1 text-muted">{{ identityMessage ? '표시할 사용량이 없습니다' : '아직 사용량 데이터가 없습니다' }}</div>
        <div class="text-faint small" v-if="!identityMessage">Claude Code 세션이 OTel Collector를 통해 집계되면 이곳에 표시됩니다.</div>
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

        <!-- 일별 토큰 사용량 바 그래프. admin/usage/index.vue의 gap-aware 패턴과 동일 CSS를
             재사용해 "결손(모름)"과 "실사용 0"을 다른 표시로 구분한다(§12.1). -->
        <div class="card p-4 mb-3" v-if="chartData.length">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="h6 mb-0">일별 토큰 사용량</h2>
            <span class="text-faint small">최근 {{ chartData.length }}일{{ gapDayCount ? ` · 결손 ${gapDayCount}일` : '' }}</span>
          </div>
          <div class="usage-chart" role="img" :aria-label="`일별 토큰 사용량, ${(meta && meta.from) || from}~${(meta && meta.to) || to}${gapDayCount ? `, 결손 ${gapDayCount}일 포함` : ''}`">
            <div class="usage-chart-bars">
              <div
                v-for="d in chartData"
                :key="d.day"
                class="usage-chart-col"
                :class="{ 'usage-chart-col--gap': d.isGap }"
                :title="d.isGap ? `${d.day} · 아직 집계되지 않음` : `${d.day} · ${formatTokens(d.tokens)} 토큰`"
              >
                <span class="usage-chart-value">{{ d.isGap ? '—' : formatTokens(d.tokens) }}<span v-if="d.isGap" class="visually-hidden">(집계 안 됨)</span></span>
                <div v-if="d.isGap" class="usage-chart-gap-band" aria-hidden="true"><div class="usage-chart-gap-marker"></div></div>
                <div v-else class="usage-chart-bar" :style="{ height: d.barPx + 'px' }"></div>
              </div>
            </div>
            <div class="usage-chart-axis">
              <span v-for="d in chartData" :key="d.day" class="usage-chart-label">{{ d.shortDay }}</span>
            </div>
          </div>
        </div>

        <!-- 모델별 일별 집계 -->
        <div class="card p-4 mb-3" v-if="dailyRows.length">
          <h2 class="h6 mb-3">일별·모델별 사용량</h2>
          <div class="table-responsive">
            <table class="table table-sm mb-0">
              <thead><tr><th>날짜</th><th>모델</th><th class="text-end">세션</th><th class="text-end">입력</th><th class="text-end">출력</th><th class="text-end">캐시읽기</th><th class="text-end">도구</th><th class="text-end">턴</th><th class="text-end">API호출</th></tr></thead>
              <tbody>
                <tr v-for="row in dailyRows" :key="row.day_at + row.model">
                  <td>{{ row.day_at }}</td>
                  <td><span class="badge bg-light text-dark">{{ row.model || '미상' }}</span></td>
                  <td class="text-end">{{ row.session_count }}</td>
                  <td class="text-end">{{ formatTokens(row.input_tokens) }}</td>
                  <td class="text-end">{{ formatTokens(row.output_tokens) }}</td>
                  <td class="text-end">{{ formatTokens(row.cache_read_tokens) }}</td>
                  <td class="text-end">{{ row.tool_calls }}</td>
                  <td class="text-end">{{ row.turns }}</td>
                  <td class="text-end">{{ row.api_calls }}</td>
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
      meta: null, // GET /api/usage/me 응답 meta(from/to/gap_days 등, docs/api.md §5.9.5) — 일별
      // 그래프의 날짜축·결손일 표시에 쓴다. dailyRows만으로 v-for를 돌리면 결손일이 조용히
      // 사라져 "0"으로 오독되므로(§12.1과 동일 원칙), admin/usage/index.vue의 검증된
      // gap-aware 그래프 패턴을 여기서도 재현한다(공유 컴포넌트로 추출하지 않는 이유는 이 파일
      // 상단 isoDaysAgo 주석 참고 — usage.vue는 의도적으로 자기 파일 안에 로컬로 유지).
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
    // meta.from~to로 날짜축을 스스로 채우고(서버가 응답을 못 줬을 때는 화면이 이미 들고 있는
    // this.from/this.to로 폴백), meta.gap_days(결손일)는 0 막대와 구분되는 결측 표시로 그린다.
    // meta가 아예 없거나 dailyRows가 0건이어도(백엔드 버그·순수 무사용 모두 포함) 전 구간을
    // "확인된 0"으로 그려 빈 화면 대신 정상적인 빈 상태를 보여준다.
    chartData() {
      const from = (this.meta && this.meta.from) || this.from
      const to = (this.meta && this.meta.to) || this.to
      if (!from || !to) return []
      const gapSet = new Set((this.meta && this.meta.gap_days) || [])
      const byDay = new Map(this.dailyRows.map((r) => [r.day_at, r]))
      const rows = enumerateUsageDays(from, to).map((day) => {
        const isGap = gapSet.has(day)
        const row = byDay.get(day)
        const tokens = isGap
          ? 0
          : row
            ? (row.total_tokens ?? (row.input_tokens || 0) + (row.output_tokens || 0) + (row.cache_read_tokens || 0) + (row.cache_write_tokens || 0))
            : 0
        return { day, tokens, isGap }
      })
      const max = Math.max(1, ...rows.filter((r) => !r.isGap).map((r) => r.tokens))
      const maxBarPx = 140
      const gapMarkerPx = 2 // 결측 마커는 0인 날의 최소 막대(2px)와 같은 높이로 — "0보다 커 보임" 오독 방지
      return rows.map((r) => ({
        ...r,
        barPx: r.isGap ? gapMarkerPx : Math.max(2, Math.round((r.tokens / max) * maxBarPx)),
        shortDay: r.day.slice(5),
      }))
    },
    gapDayCount() {
      return (this.meta && this.meta.gap_days && this.meta.gap_days.length) || 0
    },
    // 세 가지 "빈 결과" 문구 분기(§4.5) — identity_unlinked/identity_invalid는 상류 질의 자체를
    // 하지 않은 상태, user_not_in_metrics는 축은 정상인데 이 기간 관측치가 없는 상태다. 서로 다른
    // 대응이 필요해 문구도 다르게 안내한다.
    identityMessage() {
      if (!this.meta) return ''
      if (this.meta.identity_unlinked) return '사용량 연동 아이디가 아직 설정되지 않았습니다. 관리자에게 연동을 요청하세요.'
      if (this.meta.identity_invalid) return '사용량 연동 설정에 문제가 있습니다(관리자 문의).'
      if (this.meta.user_not_in_metrics) return '이 기간 사용량이 없습니다. 계속 사용 중인데도 비어 있다면 PC의 OTEL_RESOURCE_ATTRIBUTES 설정을 확인하세요.'
      return ''
    },
    identityAlertClass() {
      return this.meta && (this.meta.identity_unlinked || this.meta.identity_invalid) ? 'alert-warning' : 'alert-info'
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
      this.meta = usageRes.data?.meta || null
      this.sessions = sessionsRes.data?.data || []
    },
    formatTokens,
    formatDate,
  },
}
</script>
