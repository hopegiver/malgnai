<template>
  <div>
    <div v-if="!guardReady"></div>

    <template v-else-if="!allowed">
      <div class="alert alert-warning"><i class="bi bi-shield-lock me-1"></i>관리자만 접근할 수 있는 화면입니다.</div>
    </template>

    <template v-else>
      <div class="d-flex justify-content-between align-items-start mb-4 flex-wrap gap-2">
        <div>
          <h1 class="mb-1">사용량 통계</h1>
          <div class="text-faint small">
            출처: 사내 Prometheus(OTel) 실측치 — 자체수집 값과 다를 수 있습니다
            <span v-if="meta && meta.rollup && meta.rollup.last_sync_at"> · 롤업 마지막 집계 {{ formatDate(meta.rollup.last_sync_at) }}</span>
          </div>
        </div>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <UsagePeriodPreset v-model="presetKey" :disabled="loading" @change="onPeriodChange" />
          <button class="btn btn-sm btn-outline-secondary" @click="load" :disabled="loading" title="새로고침">
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
        <button v-if="errorRetryable" class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
      </div>

      <template v-else>
        <div v-if="partialErrorMessage" class="alert alert-warning py-2 small mb-3 d-flex justify-content-between align-items-center">
          <span><i class="bi bi-exclamation-triangle me-1"></i>{{ partialErrorMessage }}</span>
          <button v-if="partialErrorRetryable" class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
        </div>

        <div v-if="usersMeta && usersMeta.truncated" class="alert alert-info py-2 small mb-3">
          <i class="bi bi-info-circle me-1"></i>사용자가 많아 상위 {{ usersMeta.limit }}명만 표시 중입니다(전체 목록은 정렬 기준을 바꿔 확인하세요).
        </div>

        <!-- 상류(Grafana/Prometheus) 장애 — 오늘(라이브 구간)만 못 가져온 것이며 과거 데이터는 정상이다.
             에러 화면으로 바꾸지 않고 경고 배너로만 알린다(§12.1). gap_days 중 라이브 구간에 속한
             날짜는 여기 개수로만 알리고, 아래 "지금 채우기" 배너에는 중복해서 넣지 않는다(M-1 —
             "곧 채워짐(Cron)"과 "지금 재시도해야 함(상류 장애)"은 대응이 달라 뭉치면 안 된다). -->
        <div v-if="meta && meta.live_unavailable" class="alert alert-warning py-2 small mb-3 d-flex justify-content-between align-items-center">
          <span><i class="bi bi-exclamation-triangle me-1"></i>실시간 구간을 가져오지 못해 {{ (meta.segments && meta.segments.cached && meta.segments.cached.to) || '이전' }}까지만 표시합니다{{ gapDayGroups.live.length ? `(${gapDayGroups.live.length}일치)` : '' }}. 자동 적재 대상이 아니므로 다시 시도해야 채워집니다. 과거 데이터는 정상입니다.</span>
          <button class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
        </div>

        <!-- 롤업 캐시가 아직 못 채운 결손일(수집 이전·라이브 실패로 분류된 날짜는 제외, M-1) —
             Cron이 곧 채우는 "기다리면 되는" 상황이라 위 live_unavailable(상류 장애)과는 다른 배너로
             구분한다(§12.1). -->
        <div v-if="gapDayGroups.rollup.length" class="alert alert-info py-2 small mb-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
          <span><i class="bi bi-info-circle me-1"></i>{{ gapDayGroups.rollup.length }}일치가 아직 롤업 적재되지 않았습니다({{ gapDayGroups.rollup.join(', ') }}). 자동 적재를 기다리거나 지금 채울 수 있습니다.</span>
          <button class="btn btn-sm btn-outline-secondary" @click="syncGaps" :disabled="syncing">
            <span v-if="syncing" class="spinner-border spinner-border-sm me-1"></span>지금 채우기
          </button>
        </div>
        <!-- "지금 채우기" 결과 — 실제로 채운 날/애초에 채울 결손이 없던 경우/설정이 안 돼 아무것도
             못한 경우를 구분한다(C-1). 실패·설정문제는 위험색으로, 진짜 성공만 success로 표시한다. -->
        <div v-if="syncResultMessage" class="alert py-2 small mb-3" :class="`alert-${syncResultVariant}`">{{ syncResultMessage }}</div>

        <div v-if="meta && meta.window_clamped" class="alert alert-secondary py-2 small mb-3">
          <i class="bi bi-info-circle me-1"></i>수집 시작일({{ meta.data_start }}) 이전 구간은 데이터가 없습니다.
        </div>

        <div v-if="meta && meta.stale" class="alert alert-warning py-2 small mb-3">
          <i class="bi bi-info-circle me-1"></i>최신 데이터를 가져오지 못해 {{ (meta.cache && meta.cache.age_seconds) || 0 }}초 전 데이터를 표시 중입니다.
        </div>

        <!-- KPI 4종: 회사 전체(day_at 합산). summaryFailed/usersFailed는 M-3(부분 실패를 0으로 표시
             금지) — 모르는 값은 '—'로, gapDayCount는 M-6(결손이 있으면 합계는 하한) 처리. -->
        <div class="row g-3 mb-4">
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--primary p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-broadcast"></i></span><span class="pd-stat-label">세션</span></div>
              <div class="pd-stat-value">{{ summaryFailed ? '—' : (gapDayCount ? '≥' : '') + totals.sessions }}</div>
              <div class="pd-stat-sub">{{ summaryFailed ? '불러오지 못함' : (gapDayCount ? `전사 · 결손 ${gapDayCount}일 제외(하한)` : '전사 · 선택 기간') }}</div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--info p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-coin"></i></span><span class="pd-stat-label">총 토큰</span></div>
              <div class="pd-stat-value">{{ summaryFailed ? '—' : (gapDayCount ? '≥' : '') + formatTokens(totals.tokens) }}</div>
              <div class="pd-stat-sub">{{ summaryFailed ? '불러오지 못함' : '입력+출력+캐시' }}</div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--success p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-cash-coin"></i></span><span class="pd-stat-label">추정 비용</span></div>
              <div class="pd-stat-value">{{ summaryFailed ? '—' : (gapDayCount ? '≥' : '') + formatCost(totals.cost) }}</div>
              <div class="pd-stat-sub">{{ summaryFailed ? '불러오지 못함' : (gapDayCount ? `결손 ${gapDayCount}일 제외(하한, USD)` : '전사 · 선택 기간(USD)') }}</div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--neutral p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-people"></i></span><span class="pd-stat-label">활동 사용자</span></div>
              <div class="pd-stat-value">{{ usersFailed ? '—' : activeUserCount }}<span class="text-muted" style="font-size:var(--font-size-lg)">/{{ usersFailed ? '—' : (usersMeta && usersMeta.truncated ? '≥' + users.length : users.length) }}</span></div>
              <div class="pd-stat-sub">{{ usersFailed ? '불러오지 못함' : '표시된 사용자 중(미등록 포함) · 선택 기간 내 세션 발생' }}</div>
            </div>
          </div>
        </div>

        <!-- 전사 일별 토큰 사용량 -->
        <div class="card p-4 mb-3" v-if="chartData.length">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="h6 mb-0">전사 일별 토큰 사용량</h2>
            <span class="text-faint small">최근 {{ chartData.length }}일</span>
          </div>
          <div class="usage-chart" role="img" :aria-label="`전사 일별 토큰 사용량, ${meta && meta.from}~${meta && meta.to}${gapDayCount ? `, 결손 ${gapDayCount}일 포함` : ''}`">
            <div class="usage-chart-bars">
              <div
                v-for="d in chartData"
                :key="d.day"
                class="usage-chart-col"
                :class="{ 'usage-chart-col--gap': d.isGap }"
                :title="d.isGap ? `${d.day} · 아직 집계되지 않음` : `${d.day} · ${formatTokens(d.tokens)} 토큰`"
              >
                <span class="usage-chart-value">{{ d.isGap ? '—' : formatTokens(d.tokens) }}<span v-if="d.isGap" class="visually-hidden">(집계 안 됨)</span></span>
                <!-- M-2: 결측은 막대(높이로 크기 비교되는 형태)가 아니라 전체 높이 옅은 해칭 밴드 +
                     0과 같은 높이(2px)의 작은 마커로 그린다 — 예전 12px 막대는 진짜 0(2px)보다
                     커 보여 "결손"이 "다량 사용"으로 오독됐다. -->
                <div v-if="d.isGap" class="usage-chart-gap-band" aria-hidden="true"><div class="usage-chart-gap-marker"></div></div>
                <div v-else class="usage-chart-bar" :style="{ height: d.barPx + 'px' }"></div>
              </div>
            </div>
            <div class="usage-chart-axis">
              <span v-for="d in chartData" :key="d.day" class="usage-chart-label">{{ d.shortDay }}</span>
            </div>
          </div>
        </div>
        <div v-else-if="summaryFailed" class="text-center py-5 mb-3">
          <i class="bi bi-exclamation-triangle d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
          <div class="fw-medium mb-1 text-muted">전사 일별 사용량을 불러오지 못했습니다(위 배너 참고)</div>
        </div>
        <div v-else class="text-center py-5 mb-3">
          <i class="bi bi-bar-chart d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
          <div class="fw-medium mb-1 text-muted">선택 기간에 사용량 데이터가 없습니다</div>
        </div>

        <!-- 사용자별 합계 랭킹 -->
        <div class="card p-0">
          <div class="d-flex justify-content-between align-items-center p-3 pb-0">
            <h2 class="h6 mb-0">사용자별 사용량</h2>
            <small class="text-faint" v-if="usersMeta">{{ usersMeta.returned }}명 표시</small>
          </div>
          <div class="px-3 pt-2">
            <small class="text-faint">도구 호출/턴/API 호출 지표는 Prometheus가 아직 제공하지 않아 표에서 제외했습니다(0건이 아니라 측정 불가).</small>
          </div>
          <div class="table-responsive">
            <table class="table table-hover mb-0">
              <thead>
                <tr>
                  <th>사용자</th>
                  <th>역할/상태</th>
                  <th class="text-end sortable" role="button" @click="setSort('sessions')">세션<i class="bi ms-1" :class="sortIcon('sessions')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('tokens')">총 토큰<i class="bi ms-1" :class="sortIcon('tokens')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('cost')">비용<i class="bi ms-1" :class="sortIcon('cost')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('last_active')">마지막 활동<i class="bi ms-1" :class="sortIcon('last_active')"></i></th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="usersLoading"><td colspan="6" class="text-center text-faint py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...</td></tr>
                <tr
                  v-for="u in users"
                  v-else
                  :key="u.user_id || u.email"
                  :role="u.source === 'prometheus_only' ? undefined : 'button'"
                  @click="goToUser(u)"
                  :class="{ 'table-secondary': u.session_count === 0, 'usage-row--unlinked': u.source === 'prometheus_only' }"
                >
                  <td>
                    <div class="fw-medium">{{ u.name || u.email }}</div>
                    <div class="small text-faint">{{ u.email }}</div>
                  </td>
                  <td>
                    <template v-if="u.source === 'prometheus_only'">
                      <span class="badge bg-light text-dark" title="malgnai-hub 계정과 매칭되지 않아 드릴다운을 열 수 없습니다">미등록</span>
                    </template>
                    <template v-else>
                      <span class="badge me-1" :class="userRoleMeta(u.role).cls">{{ userRoleMeta(u.role).label }}</span>
                      <span class="badge" :class="userStatusMeta(u.status).cls">{{ userStatusMeta(u.status).label }}</span>
                    </template>
                  </td>
                  <td class="text-end">{{ u.session_count }}</td>
                  <td class="text-end">{{ formatTokens(u.total_tokens) }}</td>
                  <td class="text-end">{{ formatCost(u.cost_usd) }}</td>
                  <td class="text-end text-nowrap">{{ u.last_active_day || '-' }}</td>
                </tr>
                <tr v-if="!usersLoading && !users.length && usersFailed"><td colspan="6" class="text-center text-muted py-4">사용자별 목록을 불러오지 못했습니다(위 배너 참고).</td></tr>
                <tr v-else-if="!usersLoading && !users.length"><td colspan="6" class="text-center text-muted py-4">등록된 사용자가 없습니다.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<script>
export default {
  title: '사용량 통계 · malgnai-hub',
  data() {
    const initial = usagePeriodRange('30d')
    return {
      guardReady: false,
      allowed: false,

      presetKey: '30d',
      from: initial.from,
      to: initial.to,

      loading: true,
      error: false,
      errorMessage: '',
      errorRetryable: true,
      partialErrorMessage: '',
      partialErrorRetryable: true,

      summaryRows: [],
      meta: null, // /summary 응답의 meta(gap_days/live_unavailable/segments/rollup 등, §5.0)
      summaryFailed: false, // M-3: summary API가 실패했는지(0으로 위장하지 않기 위한 별도 플래그)
      users: [],
      usersMeta: null,
      usersFailed: false, // M-3: users API가 실패했는지
      usersLoading: false,

      syncing: false,
      syncResultMessage: '',
      syncResultVariant: 'secondary', // C-1: success|warning|danger|secondary — 실제 결과에 맞춘 색

      sort: 'tokens',
      order: 'desc',
    }
  },
  computed: {
    totals() {
      const t = { sessions: 0, tokens: 0, cost: 0 }
      for (const r of this.summaryRows) {
        t.sessions += r.session_count || 0
        t.tokens += (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0)
        t.cost += r.cost_usd || 0
      }
      return t
    },
    // 날짜축을 서버 응답이 아니라 meta.from~to로 스스로 채운다 — meta.gap_days(결손일)는 data[]에
    // 행 자체가 없으므로, summaryRows만으로 v-for를 돌리면 그 날짜가 조용히 사라져(=0으로 보여)
    // "아무도 안 썼다"는 거짓 표시가 된다(§12.1). 커버는 됐지만 실사용이 0인 날과, 아예 못 채운
    // gap_days를 구분해서 렌더한다.
    chartData() {
      if (!this.meta || !this.meta.from || !this.meta.to) return []
      const gapSet = new Set(this.meta.gap_days || [])
      const byDay = new Map(this.summaryRows.map((r) => [r.day_at, r]))
      const rows = enumerateUsageDays(this.meta.from, this.meta.to).map((day) => {
        const isGap = gapSet.has(day)
        const row = byDay.get(day)
        const tokens = isGap ? 0 : (row ? row.total_tokens : 0)
        return { day, tokens, isGap }
      })
      const max = Math.max(1, ...rows.filter((r) => !r.isGap).map((r) => r.tokens))
      const maxBarPx = 140
      const gapMarkerPx = 2 // M-2: 결측 마커는 0인 날의 최소 막대(2px)와 같은 높이로 — "0보다 커 보임" 오독 방지
      return rows.map((r) => ({
        ...r,
        barPx: r.isGap ? gapMarkerPx : Math.max(2, Math.round((r.tokens / max) * maxBarPx)),
        shortDay: r.day.slice(5),
      }))
    },
    activeUserCount() {
      return this.users.filter((u) => (u.session_count || 0) > 0).length
    },
    gapDayCount() {
      return (this.meta && this.meta.gap_days && this.meta.gap_days.length) || 0
    },
    // M-1: meta.gap_days에는 성격이 다른 3종류(수집 이전 / 오늘 라이브 실패 / 진짜 롤업 결손)가
    // 섞여 온다. 배너마다 "기다리면 되는지 / 다시 시도해야 하는지"가 다르므로 분리해서 각 배너가
    // 자기 몫만 말하게 한다(하나로 뭉치면 관리자가 판단할 수 없다, §12.1).
    //
    // 분류 경계로 meta.segments.cached.to(§5.0 "cacheTo = isToday ? yesterday : clampedTo")를 쓴다 —
    // 이 값은 "이번 요청이 캐시로 커버할 수 있는 이론상 상한(=어제)"이라 실제 연속 적재 여부와
    // 무관하다. 그래서 day >= cachedTo인 gap(오늘·어제 등 라이브가 담당했어야 할 구간)만 "라이브
    // 실패"로 보고, 그보다 앞선 날짜(=이미 캐시 대상 구간인데 구멍난 날)는 Cron/수동 적재가
    // 담당하는 "롤업 결손"으로 본다. 실측 확인(2026-09-04, 로컬): live_unavailable=true 상태에서
    // 인위로 만든 중간 결손(cachedTo보다 훨씬 이전 날짜)이 정확히 rollup으로, 실제 오늘/어제
    // 라이브 실패일은 live로 분류됨을 확인했다. data_start·rollup.cached_through만으로는 이 구분이
    // 안 된다(cached_through는 "연속 적재 마지막 날"이라 중간 결손 하나만 있어도 그 이후 전부가
    // "연속 아님"으로 붕괴해 버려, 실제로는 이미 캐시에 있는 최근 날짜까지 라이브로 오분류된다 —
    // 그래서 연속성이 아니라 "이 요청이 캐시에 기대한 상한"인 segments.cached.to를 쓴다).
    gapDayGroups() {
      const gaps = (this.meta && this.meta.gap_days) || []
      const dataStart = this.meta && this.meta.data_start
      const liveUnavailable = !!(this.meta && this.meta.live_unavailable)
      const cachedTo = this.meta && this.meta.segments && this.meta.segments.cached && this.meta.segments.cached.to
      const before = [] // data_start 이전 — 영원히 안 채워짐(window_clamped 배너가 이미 알린다)
      const live = [] // live_unavailable로 오늘(라이브 구간)을 못 가져온 날 — 재시도해야 채워짐
      const rollup = [] // 그 외 — Cron/수동 적재가 채우는 진짜 결손
      for (const day of gaps) {
        if (dataStart && day < dataStart) { before.push(day); continue }
        if (liveUnavailable && (!cachedTo || day >= cachedTo)) { live.push(day); continue }
        rollup.push(day)
      }
      return { before, live, rollup }
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
    onPeriodChange(range) {
      this.from = range.from
      this.to = range.to
      this.load()
    },
    usersQuery() {
      return new URLSearchParams({
        from: this.from,
        to: this.to,
        sort: this.sort,
        order: this.order,
        limit: '200',
      }).toString()
    },
    async load() {
      this.loading = true
      this.error = false
      this.partialErrorMessage = ''
      this.partialErrorRetryable = true
      // m-5②: 낡은 sync 결과 문구가 기간 변경·재조회 후에도 남아 다른 기간의 결과처럼 읽히는 것을
      // 막는다(syncGaps()는 이 load() 호출이 끝난 뒤 자기 메시지를 다시 설정하므로 안전하다).
      this.syncResultMessage = ''
      const [summaryRes, usersRes] = await Promise.all([
        useApi(`/api/admin/usage/summary?from=${this.from}&to=${this.to}`),
        useApi(`/api/admin/usage/users?${this.usersQuery()}`),
      ])
      this.loading = false
      this.summaryFailed = !!summaryRes.error
      this.usersFailed = !!usersRes.error
      if (summaryRes.error && usersRes.error) {
        this.error = true
        const info = usageErrorMessage(summaryRes.error || usersRes.error)
        this.errorMessage = info.message
        this.errorRetryable = info.retryable
        return
      }
      // 둘 중 하나만 실패한 경우: 성공한 쪽 데이터는 버리지 않고 그대로 보여주되(반환하지 않는다),
      // 실패 사실은 배너로 반드시 노출한다 — 조용히 0/빈 값으로 보이는 것을 막기 위함(M-3).
      if (summaryRes.error || usersRes.error) {
        const failedName = summaryRes.error ? '전사 요약(KPI/일별 그래프)' : '사용자별 목록'
        const info = usageErrorMessage(summaryRes.error || usersRes.error)
        this.partialErrorMessage = `${failedName} 데이터를 불러오지 못했습니다 — ${info.message} 나머지 데이터만 최신입니다.`
        this.partialErrorRetryable = info.retryable
      }
      this.summaryRows = summaryRes.error ? [] : (summaryRes.data?.data || [])
      this.meta = summaryRes.error ? null : (summaryRes.data?.meta || null)
      this.users = usersRes.error ? [] : (usersRes.data?.data || [])
      this.usersMeta = usersRes.error ? null : (usersRes.data?.meta || null)
    },
    // 관리자가 결손일(gap_days)을 Cron까지 기다리지 않고 즉시 채우는 수동 트리거(설계 §18.7 — 선택
    // 기능). 부분 성공도 200으로 온다 — committed_days가 있으면 그만큼은 실제로 채워진 것이다.
    //
    // C-1 — "실제로 채운 날이 있는가" / "채울 결손이 애초에 없었는가" / "설정이 안 돼 아무것도 못
    // 했는가"를 구분한다. 서버 응답(server/lib/usage-rollup.js)의 `skipped:'not_configured'`(상류
    // 설정 없음)·`no_progress`(대상은 있는데 청크를 하나도 시도 못함, 서버 예산 설정 결함 신호)를
    // 그냥 committed=0으로 뭉개면 "0일치를 적재했습니다. 결손이 모두 해소됐습니다"라는 거짓 성공이
    // 나온다(아무 일도 안 했는데 해결됐다고 보고하는 것 — 이 리스크 범주에서 가장 나쁜 형태).
    async syncGaps() {
      this.syncing = true
      // m-5④: 응답이 영영 안 오면 syncing이 영구 true가 돼 버튼이 죽는다(좀비 상태). 60초 후
      // 클라이언트에서 스스로 포기한다 — 공유 useApi()의 기본 동작은 바꾸지 않고 이 호출에만 적용.
      const timeout = new Promise((resolve) => {
        setTimeout(() => resolve({ data: null, error: { message: '응답을 받지 못했습니다(60초 초과).' } }), 60000)
      })
      const { data, error } = await Promise.race([useApi('/api/admin/usage/sync', { method: 'POST' }), timeout])
      this.syncing = false

      let message
      let variant
      if (error) {
        variant = 'danger'
        message = `롤업 적재에 실패했습니다${error?.message ? ` — ${error.message}` : ''}.`
      } else if (data?.skipped === 'not_configured') {
        variant = 'warning'
        message = '사용량 수집이 아직 설정되지 않아 적재하지 않았습니다(관리자 설정 필요 — 다시 눌러도 채워지지 않습니다).'
      } else if (data?.no_progress) {
        variant = 'danger'
        message = '적재를 시도조차 하지 못했습니다(서버 설정 문제로 추정) — 관리자에게 문의하세요.'
      } else {
        const committed = data?.committed_days?.length || 0
        const remaining = data?.remaining_gap_days?.length || 0
        if (committed === 0 && remaining === 0) {
          variant = 'secondary'
          message = '적재할 결손이 없습니다.'
        } else if (remaining > 0) {
          variant = 'warning'
          message = `${committed}일치를 적재했습니다. ${remaining}일치가 남아 있어 다시 눌러야 합니다${data?.budget_exhausted ? '(시간 예산 초과)' : ''}.`
        } else {
          variant = 'success'
          message = `${committed}일치를 적재했습니다. 결손이 모두 해소됐습니다.`
        }
      }
      // load()가 내부에서 syncResultMessage를 비우므로(m-5②), 반드시 load() 완료 뒤에 최종 문구를 설정한다.
      await this.load()
      this.syncResultMessage = message
      this.syncResultVariant = variant
    },
    // 정렬 기준만 바뀌면 사용자 목록만 다시 받는다(전사 KPI/차트는 기간에만 의존).
    async loadUsersOnly() {
      this.usersLoading = true
      this.partialErrorMessage = ''
      this.partialErrorRetryable = true
      const { data, error } = await useApi(`/api/admin/usage/users?${this.usersQuery()}`)
      this.usersLoading = false
      if (error) {
        // 재정렬 실패 시 직전 목록은 그대로 유지하되(빈 화면으로 튀지 않게), 실패 사실은 배너로
        // 알린다(M-3). usersFailed는 건드리지 않는다 — 화면에 남은 목록은 여전히 유효한 값이라
        // KPI를 '—'로 바꾸면 오히려 멀쩡한 값을 숨기게 된다.
        const info = usageErrorMessage(error)
        this.partialErrorMessage = `사용자별 목록을 다시 불러오지 못했습니다 — ${info.message} 이전 정렬 결과를 계속 표시합니다.`
        this.partialErrorRetryable = info.retryable
        return
      }
      this.users = data?.data || []
      this.usersMeta = data?.meta || null
    },
    setSort(key) {
      if (this.sort === key) {
        this.order = this.order === 'desc' ? 'asc' : 'desc'
      } else {
        this.sort = key
        this.order = key === 'name' ? 'asc' : 'desc'
      }
      this.loadUsersOnly()
    },
    sortIcon(key) {
      if (this.sort !== key) return 'bi-chevron-expand text-faint'
      return this.order === 'desc' ? 'bi-chevron-down' : 'bi-chevron-up'
    },
    // Prometheus-only 행(user_id === null)은 malgnai-hub 계정이 없어 드릴다운을 열 수 없다(§5.1).
    goToUser(u) {
      if (u.source === 'prometheus_only' || !u.user_id) return
      this.$router.push(`/admin/usage/${u.user_id}`)
    },
    formatTokens,
    formatCost,
    formatDate,
    userRoleMeta,
    userStatusMeta,
  },
}
</script>

<style>
.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
.sortable:hover { color: var(--color-brand); }
.usage-row--unlinked { cursor: default; opacity: 0.75; }
</style>
