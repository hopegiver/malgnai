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
      <!-- 부분 실패 배너(M-3) — /api/usage/me와 /api/usage/sessions는 서로 다른 소스라 한쪽만
           실패할 수 있다. 실패한 쪽을 빈 값으로 두면 화면이 "당신은 사용하지 않았습니다"라고
           말하게 된다(상류 장애를 무사용으로 위장). 관리자 화면(admin/usage/index.vue)이 이미
           쓰는 partialErrorMessage 패턴을 그대로 이식한다. -->
      <div v-if="partialErrorMessage" class="alert alert-warning py-2 small mb-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
        <span><i class="bi bi-exclamation-triangle me-1"></i>{{ partialErrorMessage }}</span>
        <button v-if="partialErrorRetryable" class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
      </div>

      <!-- 세 가지 "빈 결과" 문구 분기(docs/design/usage-employee-identity-linking.md §4.5) — "고장"과
           "사용 안 함"을 구별한다. dailyRows/chartData 계산 로직은 건드리지 않고 이 배너만 얹는다. -->
      <div v-if="identityMessage" class="alert py-2 small mb-3" :class="identityAlertClass">
        <i class="bi" :class="identityAlertIcon"></i>{{ identityMessage }}
      </div>

      <!-- 빈 상태: 아직 2단계 데이터 없음 -->
      <div v-if="!dailyRows.length && !sessions.length" class="text-center py-5">
        <i class="bi bi-bar-chart d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
        <div class="fw-medium mb-1 text-muted">{{ emptyStateTitle }}</div>
        <div class="text-faint small" v-if="!identityMessage && !usageFailed">Claude Code 세션이 OTel Collector를 통해 집계되면 이곳에 표시됩니다.</div>
      </div>

      <template v-else>
        <!-- M-2 — 개인 축 수치(KPI·일별 그래프·일별 표)는 "실제로 측정된 경우"에만 그린다.
             공용 워크스테이션 축·미연동·형식오류는 서버가 상류 질의 자체를 건너뛰어 data:[]로
             오고(gap_days도 []), 그 상태에서 이 블록을 그리면 전 기간 0 막대 + KPI 0이 "측정 결과
             0"이라는 적극적 거짓 진술이 된다(측정하지 않은 것과 0인 것은 다르다). /api/usage/me
             자체가 실패한 경우도 같다 — 모르는 값을 0으로 그리지 않는다. -->
        <template v-if="showMeasuredUsage">
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
                  <tr v-for="row in sortedDailyRows" :key="row.day_at + row.model">
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

        </template>
        <!-- 측정하지 않은(또는 못 불러온) 상태 — 0 막대 대신 그 사실을 문장으로 말한다. -->
        <div v-else class="card p-4 mb-3">
          <div class="d-flex align-items-start gap-2">
            <i class="bi bi-slash-circle text-faint mt-1"></i>
            <div>
              <div class="fw-medium mb-1">{{ usageFailed ? '개인 사용량 집계를 표시할 수 없습니다' : '이 축은 개인 사용량으로 측정하지 않습니다' }}</div>
              <div class="text-faint small">
                {{ usageFailed
                  ? '집계를 불러오지 못해 KPI와 일별 그래프를 표시하지 않습니다. 0이 아니라 알 수 없는 상태입니다 — 위 배너의 “다시 시도”를 눌러 주세요.'
                  : '위 안내에 해당하는 상태라 상류 사용량 집계를 조회하지 않았습니다. 그래프를 0으로 그리면 “측정 결과 0”으로 오해되므로 표시하지 않습니다.' }}
              </div>
            </div>
          </div>
        </div>

        <!-- 최근 세션 -->
        <div class="card p-4">
          <h2 class="h6 mb-3">최근 세션</h2>
          <!-- 세션 카드는 개인 사용량 집계(상류 Prometheus)와 소스가 다르다(PC의 수집 에이전트가
               보낸 자체수집 값). 위에서 개인 수치를 표시하지 않는 상태라면 이 목록이 그 대체값으로
               읽히지 않도록 출처를 병기한다. -->
          <p v-if="!showMeasuredUsage" class="text-faint small mb-3">
            아래 목록은 PC의 수집 에이전트가 보낸 <strong>자체수집 세션 기록</strong>입니다 — 위의 개인 사용량 집계(사내 Prometheus 실측)와는 다른 소스이며, 개인 사용량 수치를 대신하지 않습니다.
          </p>
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
          <!-- 세션 목록도 같은 원칙 — 못 불러온 것을 "없다"로 말하지 않는다(M-3). -->
          <p v-else class="text-muted mb-0 small">{{ sessionsFailed ? '세션 목록을 불러오지 못했습니다(위 배너 참고). 세션이 없다는 뜻이 아닙니다.' : '선택 기간에 동기화된 세션이 없습니다.' }}</p>
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
      // 부분 실패 상태(M-3) — 두 요청 중 한쪽만 실패한 경우. usageFailed는 "개인 사용량 집계를
      // 모른다"는 뜻이라 화면이 그 구간을 0으로 그리지 못하게 하는 스위치도 겸한다.
      usageFailed: false,
      sessionsFailed: false,
      partialErrorMessage: '',
      partialErrorRetryable: true,
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
    // 이 computed는 "실제로 측정된 구간"에서만 렌더된다(템플릿의 showMeasuredUsage 게이트) —
    // 측정을 건너뛴 축(공용 PC·미연동·형식오류)이나 조회 실패는 여기 오기 전에 걸러지므로,
    // 남은 dailyRows 0건은 "질의했는데 사용이 없었다"는 뜻이고 전 구간 0 막대가 참이다(M-2).
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
    // "일별·모델별 사용량" 표만 최신 날짜가 먼저 보이도록 정렬한다(그래프의 chartData/dailyRows
    // 원본은 그대로 둔다). Array#sort는 표준상 안정 정렬이라 같은 날짜(day_at)의 모델 간 상대
    // 순서는 dailyRows에 있던 그대로 유지된다.
    sortedDailyRows() {
      return [...this.dailyRows].sort((a, b) => b.day_at.localeCompare(a.day_at))
    },
    // 세 가지 "빈 결과" 문구 분기(§4.5) — identity_unlinked/identity_invalid는 상류 질의 자체를
    // 하지 않은 상태, user_not_in_metrics는 축은 정상인데 이 기간 관측치가 없는 상태다. 서로 다른
    // 대응이 필요해 문구도 다르게 안내한다.
    identityMessage() {
      if (!this.meta) return ''
      if (this.meta.identity_unlinked) return '사용량 연동 아이디가 아직 설정되지 않았습니다. 관리자에게 연동을 요청하세요.'
      // 공용 워크스테이션 축(docs/api.md §5.9.5 빈 결과 4종) — 연동은 돼 있지만 그 값이 여러 명이
      // 함께 쓰는 PC의 축이라 개인 사용량으로 표시하지 않는다(표시하면 그 자체가 오귀속이고,
      // 당사자는 자기 숫자가 부풀었다는 사실을 알 수 없다). 미연동/형식오류와 조치가 달라 문구를
      // 분리한다 — 이건 "설정이 빠졌다"가 아니라 "이 축은 개인 것이 아니다"라는 뜻이다.
      if (this.meta.identity_shared_workstation) {
        const id = this.meta.employee_id ? `(${this.meta.employee_id})` : ''
        return `연동된 아이디${id}는 여러 명이 함께 쓰는 공용 PC로 등록되어 있어 개인 사용량으로 표시하지 않습니다. 개인 사용량 연동은 관리자에게 문의하세요.`
      }
      if (this.meta.identity_invalid) return '사용량 연동 설정에 문제가 있습니다(관리자 문의).'
      if (this.meta.user_not_in_metrics) return '이 기간 사용량이 없습니다. 계속 사용 중인데도 비어 있다면 PC의 OTEL_RESOURCE_ATTRIBUTES 설정을 확인하세요.'
      return ''
    },
    // 서버가 상류 질의 자체를 건너뛴 상태(docs/api.md §5.9.5 빈 결과 4종 중 3종) — 이때 data:[]와
    // gap_days:[]는 "관측 결과가 0"이 아니라 "측정 대상이 아니다"라는 뜻이다. user_not_in_metrics는
    // 여기 포함하지 않는다(축은 정상이고 실제로 질의한 결과가 0건 — 그건 진짜 0이다).
    identitySkipped() {
      return !!(this.meta && (this.meta.identity_unlinked || this.meta.identity_invalid || this.meta.identity_shared_workstation))
    },
    // 개인 축 수치(KPI·그래프·일별 표)를 그려도 되는가. 측정하지 않았거나 못 불러온 값을 0으로
    // 그리지 않기 위한 단일 스위치다(M-2·M-3).
    showMeasuredUsage() {
      return !this.usageFailed && !this.identitySkipped
    },
    emptyStateTitle() {
      if (this.usageFailed) return '사용량을 불러오지 못했습니다'
      return this.identityMessage ? '표시할 사용량이 없습니다' : '아직 사용량 데이터가 없습니다'
    },
    identityAlertClass() {
      if (!this.meta) return 'alert-info'
      return this.meta.identity_unlinked || this.meta.identity_invalid || this.meta.identity_shared_workstation ? 'alert-warning' : 'alert-info'
    },
    identityAlertIcon() {
      if (this.meta && this.meta.identity_shared_workstation) return 'bi-pc-display me-1'
      return this.meta && (this.meta.identity_unlinked || this.meta.identity_invalid) ? 'bi-exclamation-triangle me-1' : 'bi-info-circle me-1'
    },
  },
  async mounted() {
    await this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.error = false
      this.partialErrorMessage = ''
      this.partialErrorRetryable = true
      const [usageRes, sessionsRes] = await Promise.all([
        useApi(`/api/usage/me?from=${this.from}&to=${this.to}`),
        useApi('/api/usage/sessions?limit=20'),
      ])
      this.loading = false
      this.usageFailed = !!usageRes.error
      this.sessionsFailed = !!sessionsRes.error
      if (usageRes.error && sessionsRes.error) {
        this.error = true
        const info = usageErrorMessage(usageRes.error)
        this.errorMessage = info.message
        return
      }
      // 한쪽만 실패한 경우(M-3): 성공한 쪽은 그대로 보여주되 실패 사실을 반드시 배너로 알린다.
      // 특히 /api/usage/me만 실패하면 dailyRows=[]·meta=null이 되어 화면이 "아직 사용량 데이터가
      // 없습니다"로 렌더됐다 — 상류 장애가 "당신은 사용하지 않았습니다"로 표시되는 위장이다.
      if (usageRes.error || sessionsRes.error) {
        const failedName = usageRes.error ? '개인 사용량 집계(KPI/일별 그래프)' : '최근 세션 목록'
        const info = usageErrorMessage(usageRes.error || sessionsRes.error)
        this.partialErrorMessage = `${failedName} 데이터를 불러오지 못했습니다 — ${info.message} 나머지 데이터만 표시합니다.`
        this.partialErrorRetryable = info.retryable !== false
      }
      this.dailyRows = usageRes.error ? [] : (usageRes.data?.data || [])
      this.meta = usageRes.error ? null : (usageRes.data?.meta || null)
      this.sessions = sessionsRes.error ? [] : (sessionsRes.data?.data || [])
    },
    formatTokens,
    formatDate,
  },
}
</script>
