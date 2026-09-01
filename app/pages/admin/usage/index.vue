<template>
  <div>
    <div v-if="!guardReady"></div>

    <template v-else-if="!allowed">
      <div class="alert alert-warning"><i class="bi bi-shield-lock me-1"></i>관리자만 접근할 수 있는 화면입니다.</div>
    </template>

    <template v-else>
      <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
        <h1 class="mb-0">사용량 통계</h1>
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
        <button class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
      </div>

      <template v-else>
        <div v-if="partialErrorMessage" class="alert alert-warning py-2 small mb-3 d-flex justify-content-between align-items-center">
          <span><i class="bi bi-exclamation-triangle me-1"></i>{{ partialErrorMessage }}</span>
          <button class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
        </div>

        <div v-if="usersMeta && usersMeta.truncated" class="alert alert-info py-2 small mb-3">
          <i class="bi bi-info-circle me-1"></i>사용자가 많아 상위 {{ usersMeta.limit }}명만 표시 중입니다(전체 목록은 정렬 기준을 바꿔 확인하세요).
        </div>

        <!-- KPI 4종: 회사 전체(day_at 합산) -->
        <div class="row g-3 mb-4">
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--primary p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-broadcast"></i></span><span class="pd-stat-label">세션</span></div>
              <div class="pd-stat-value">{{ totals.sessions }}</div>
              <div class="pd-stat-sub">전사 · 선택 기간</div>
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
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-people"></i></span><span class="pd-stat-label">활동 사용자</span></div>
              <div class="pd-stat-value" style="font-size:var(--font-size-4xl)">{{ activeUserCount }}<span class="text-muted" style="font-size:var(--font-size-lg)">/{{ users.length }}</span></div>
              <div class="pd-stat-sub">선택 기간 내 세션 발생</div>
            </div>
          </div>
        </div>

        <!-- 전사 일별 토큰 사용량 -->
        <div class="card p-4 mb-3" v-if="chartData.length">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="h6 mb-0">전사 일별 토큰 사용량</h2>
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
          <div class="table-responsive">
            <table class="table table-hover mb-0">
              <thead>
                <tr>
                  <th>사용자</th>
                  <th>역할/상태</th>
                  <th class="text-end sortable" role="button" @click="setSort('sessions')">세션<i class="bi ms-1" :class="sortIcon('sessions')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('tokens')">총 토큰<i class="bi ms-1" :class="sortIcon('tokens')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('tool_errors')">도구오류<i class="bi ms-1" :class="sortIcon('tool_errors')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('turns')">턴<i class="bi ms-1" :class="sortIcon('turns')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('api_calls')">API호출<i class="bi ms-1" :class="sortIcon('api_calls')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('last_active')">마지막 활동<i class="bi ms-1" :class="sortIcon('last_active')"></i></th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="usersLoading"><td colspan="7" class="text-center text-faint py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...</td></tr>
                <tr
                  v-for="u in users"
                  v-else
                  :key="u.user_id"
                  role="button"
                  @click="goToUser(u)"
                  :class="{ 'table-secondary': u.session_count === 0 }"
                >
                  <td>
                    <div class="fw-medium">{{ u.name || u.email }}</div>
                    <div class="small text-faint">{{ u.email }}</div>
                  </td>
                  <td>
                    <span class="badge me-1" :class="userRoleMeta(u.role).cls">{{ userRoleMeta(u.role).label }}</span>
                    <span class="badge" :class="userStatusMeta(u.status).cls">{{ userStatusMeta(u.status).label }}</span>
                  </td>
                  <td class="text-end">{{ u.session_count }}</td>
                  <td class="text-end">{{ formatTokens(u.total_tokens) }}</td>
                  <td class="text-end">{{ u.tool_errors }}</td>
                  <td class="text-end">{{ u.turns }}</td>
                  <td class="text-end">{{ u.api_calls }}</td>
                  <td class="text-end text-nowrap">{{ u.last_active_day || '-' }}</td>
                </tr>
                <tr v-if="!usersLoading && !users.length"><td colspan="7" class="text-center text-muted py-4">등록된 사용자가 없습니다.</td></tr>
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
      partialErrorMessage: '',

      summaryRows: [],
      users: [],
      usersMeta: null,
      usersLoading: false,

      sort: 'tokens',
      order: 'desc',
    }
  },
  computed: {
    totals() {
      const t = { sessions: 0, tokens: 0, toolCalls: 0, toolErrors: 0 }
      for (const r of this.summaryRows) {
        t.sessions += r.session_count || 0
        t.tokens += (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0)
        t.toolCalls += r.tool_calls || 0
        t.toolErrors += r.tool_errors || 0
      }
      return t
    },
    chartData() {
      // usage.vue chartData 계산식과 동일(막대 높이 산출 방식 통일) — 대상 행만 회사 전체 집계로 다름.
      const rows = this.summaryRows.map((r) => ({
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
    activeUserCount() {
      return this.users.filter((u) => (u.session_count || 0) > 0).length
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
      const [summaryRes, usersRes] = await Promise.all([
        useApi(`/api/admin/usage/summary?from=${this.from}&to=${this.to}`),
        useApi(`/api/admin/usage/users?${this.usersQuery()}`),
      ])
      this.loading = false
      if (summaryRes.error && usersRes.error) {
        this.error = true
        this.errorMessage = summaryRes.error?.message || usersRes.error?.message || '사용량 데이터를 불러오지 못했습니다.'
        return
      }
      // 둘 중 하나만 실패한 경우: 성공한 쪽 데이터는 버리지 않고 그대로 보여주되(반환하지 않는다),
      // 실패 사실은 배너로 반드시 노출한다 — 조용히 0/빈 값으로 보이는 것을 막기 위함(M-3).
      if (summaryRes.error || usersRes.error) {
        const failedName = summaryRes.error ? '전사 요약(KPI/일별 그래프)' : '사용자별 목록'
        const msg = (summaryRes.error || usersRes.error)?.message
        this.partialErrorMessage = `${failedName} 데이터를 불러오지 못했습니다${msg ? ` — ${msg}` : ''}. 나머지 데이터만 최신입니다.`
      }
      this.summaryRows = summaryRes.error ? [] : (summaryRes.data?.data || [])
      this.users = usersRes.error ? [] : (usersRes.data?.data || [])
      this.usersMeta = usersRes.error ? null : (usersRes.data?.meta || null)
    },
    // 정렬 기준만 바뀌면 사용자 목록만 다시 받는다(전사 KPI/차트는 기간에만 의존).
    async loadUsersOnly() {
      this.usersLoading = true
      this.partialErrorMessage = ''
      const { data, error } = await useApi(`/api/admin/usage/users?${this.usersQuery()}`)
      this.usersLoading = false
      if (error) {
        // 재정렬 실패 시 직전 목록은 그대로 유지하되(빈 화면으로 튀지 않게), 실패 사실은 배너로 알린다(M-3).
        this.partialErrorMessage = `사용자별 목록을 다시 불러오지 못했습니다${error?.message ? ` — ${error.message}` : ''}. 이전 정렬 결과를 계속 표시합니다.`
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
    goToUser(u) {
      this.$router.push(`/admin/usage/${u.user_id}`)
    },
    formatTokens,
    userRoleMeta,
    userStatusMeta,
  },
}
</script>

<style>
.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
.sortable:hover { color: var(--color-brand); }
</style>
