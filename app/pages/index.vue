<template>
  <div>
    <!-- [A] 승인 대기 배너 -->
    <div class="card p-3 mb-4 d-flex flex-row align-items-center flex-wrap gap-3"
         :class="inbox.pending > 0 ? 'border-start border-4 border-danger' : 'border-start border-4 border-success'">
      <div class="flex-grow-1">
        <div v-if="loading" class="text-muted small">불러오는 중...</div>
        <div v-else-if="inbox.pending > 0" class="d-flex align-items-center flex-wrap gap-2">
          <span class="fw-semibold"><i class="bi bi-exclamation-triangle-fill text-danger me-1"></i>승인 대기 {{ inbox.pending }}건</span>
          <span v-if="inbox.pending_high" class="badge bg-danger">높음 {{ inbox.pending_high }}</span>
          <span v-if="inbox.pending_medium" class="badge bg-warning">보통 {{ inbox.pending_medium }}</span>
          <span v-if="inbox.pending_low" class="badge bg-secondary">낮음 {{ inbox.pending_low }}</span>
          <span v-if="inbox.failed > 0" class="text-danger small ms-1"><i class="bi bi-x-circle me-1"></i>실패 {{ inbox.failed }}건</span>
        </div>
        <div v-else class="fw-medium text-muted">
          <i class="bi bi-check2-circle me-1" style="color:var(--color-accent-green)"></i>확인할 항목이 없습니다
        </div>
      </div>
      <router-link v-if="!loading && inbox.pending > 0" to="/approvals" class="btn btn-danger btn-sm flex-shrink-0">
        승인함 가기 <i class="bi bi-arrow-right ms-1"></i>
      </router-link>
    </div>

    <!-- [B] 자율 상태 인디케이터 (admin only) -->
    <div v-if="admin && !loading" class="card p-3 mb-4">
      <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
        <div class="d-flex align-items-center gap-2">
          <span class="autonomy-dot-lg" :class="autoEnabled ? 'dot-on' : 'dot-off'"></span>
          <div>
            <div class="fw-semibold" style="font-size:14px">{{ autoEnabled ? '자율 가동 중' : '자율 정지' }}</div>
            <div class="text-faint" style="font-size:12px">{{ autoEnabled ? '에이전트가 스스로 업무를 판단·수행합니다' : '마스터 킬스위치가 꺼져 있습니다' }}</div>
          </div>
        </div>
        <router-link to="/autonomy" class="btn btn-sm btn-outline-secondary">자율 제어판 →</router-link>
      </div>
    </div>

    <!-- [C] 진행중 프로젝트 카드 -->
    <div class="mb-4">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h2 class="h6 mb-0"><i class="bi bi-folder2-open me-1"></i>진행중 프로젝트</h2>
        <router-link to="/projects" class="small text-decoration-none">전체 보기 →</router-link>
      </div>

      <div v-if="loading">
        <div class="skeleton-line mb-2" style="height:80px;border-radius:8px"></div>
        <div class="skeleton-line" style="height:80px;border-radius:8px"></div>
      </div>

      <div v-else-if="activeProjects.length" class="row g-2">
        <div class="col-12 col-md-6 col-xl-4" v-for="p in activeProjects" :key="p.id">
          <div class="card home-proj-card" @click="$router.push('/projects/' + p.id)" style="cursor:pointer">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <span class="fw-semibold text-truncate me-2" style="font-size:14px">{{ p.name }}</span>
              <span class="d-flex align-items-center gap-1 flex-shrink-0" style="font-size:11px" :class="p.autonomy_active ? 'text-success' : 'text-muted'">
                <span class="project-card-dot" :class="p.autonomy_active ? 'project-card-dot--on' : 'project-card-dot--off'"></span>
                {{ p.autonomy_active ? '가동' : '정지' }}
              </span>
            </div>
            <div class="text-faint" style="font-size:11px">
              <i class="bi bi-clock me-1"></i>{{ relativeTime(p.updated_at) }}
            </div>
          </div>
        </div>
      </div>

      <div v-else class="text-center py-4">
        <i class="bi bi-rocket-takeoff d-block mb-2" style="font-size:2rem;color:var(--color-ink-faint)"></i>
        <div class="text-muted small mb-2">아직 진행중인 프로젝트가 없습니다</div>
        <router-link to="/projects" class="btn btn-primary btn-sm"><i class="bi bi-plus-lg me-1"></i>첫 프로젝트 만들기</router-link>
      </div>
    </div>

    <!-- [D] 최근 AI 활동 + KPI 카드 -->
    <div class="row g-3 mb-4">
      <!-- KPI 4개 -->
      <div class="col-6 col-md-3">
        <div class="card pd-stat pd-stat--primary p-3">
          <div class="pd-stat-top">
            <span class="pd-stat-icon"><i class="bi bi-folder"></i></span>
            <span class="pd-stat-label">전체 프로젝트</span>
          </div>
          <div class="pd-stat-value">{{ loading ? '—' : summary.total_projects }}</div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="card pd-stat pd-stat--info p-3">
          <div class="pd-stat-top">
            <span class="pd-stat-icon"><i class="bi bi-arrow-repeat"></i></span>
            <span class="pd-stat-label">진행중</span>
          </div>
          <div class="pd-stat-value">{{ loading ? '—' : (summary.by_status?.active || 0) }}</div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="card pd-stat p-3" :class="(summary.by_status?.completed || 0) > 0 ? 'pd-stat--success' : 'pd-stat--neutral'">
          <div class="pd-stat-top">
            <span class="pd-stat-icon"><i class="bi bi-check-circle"></i></span>
            <span class="pd-stat-label">완료</span>
          </div>
          <div class="pd-stat-value">{{ loading ? '—' : (summary.by_status?.completed || 0) }}</div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="card pd-stat pd-stat--neutral p-3">
          <div class="pd-stat-top">
            <span class="pd-stat-icon"><i class="bi bi-robot"></i></span>
            <span class="pd-stat-label">에이전트</span>
          </div>
          <div class="pd-stat-value">{{ loading ? '—' : (summary.agents?.length || 0) }}</div>
        </div>
      </div>
    </div>

    <!-- 최근 AI 활동 미니피드 -->
    <div class="card p-4 mb-4">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h2 class="h6 mb-0"><i class="bi bi-lightning me-1"></i>최근 AI 활동</h2>
        <router-link to="/activities" class="small text-decoration-none">전체 보기 →</router-link>
      </div>
      <div v-if="loading">
        <div class="skeleton-line mb-2" style="height:14px"></div>
        <div class="skeleton-line mb-2" style="height:14px;width:80%"></div>
        <div class="skeleton-line" style="height:14px;width:60%"></div>
      </div>
      <div v-else-if="recentActivities.length">
        <div v-for="a in recentActivities.slice(0, 5)" :key="a.id" class="activity-mini-row">
          <span class="text-faint flex-shrink-0" style="font-size:11px;min-width:52px">{{ relativeTime(a.created_at) }}</span>
          <span v-if="a.agent_name" class="badge bg-secondary-subtle text-secondary flex-shrink-0" style="font-size:10px">{{ a.agent_name }}</span>
          <router-link v-if="a.project_id" :to="'/projects/' + a.project_id" class="text-faint flex-shrink-0 text-decoration-none" style="font-size:11px">
            <i class="bi bi-folder"></i> {{ a.project_name || a.project_id }}
          </router-link>
          <span class="text-truncate" style="font-size:13px">{{ activityTitle(a) }}</span>
          <span class="ms-auto flex-shrink-0" :class="a.result === 'success' ? 'text-success' : a.result === 'failure' ? 'text-danger' : 'text-faint'" style="font-size:12px">
            <i class="bi" :class="a.result === 'success' ? 'bi-check2' : a.result === 'failure' ? 'bi-x' : 'bi-dash'"></i>
          </span>
        </div>
      </div>
      <div v-else class="text-muted small">아직 기록된 활동이 없습니다.</div>
    </div>

    <!-- [E] AI 비용 + 가동현황 (admin) -->
    <div v-if="admin" class="row g-3 mb-4">
      <div class="col-12 col-lg-6">
        <div class="card pd-stat pd-stat--success p-4 h-100">
          <div class="pd-stat-top">
            <span class="pd-stat-icon"><i class="bi bi-cash-stack"></i></span>
            <span class="pd-stat-label">AI 실비용 (월 정액 구독)</span>
          </div>
          <div class="d-flex align-items-end justify-content-between flex-wrap gap-2">
            <div class="pd-progress-value">${{ (cost.plan_usd || 0).toFixed(0) }}<span class="fs-6 text-muted">/월</span></div>
            <div class="pd-stat-sub text-end">
              이번 달 절감효과 <span class="text-success fw-semibold">+${{ (cost.saved_month || 0).toFixed(0) }}</span><br>
              <span class="text-faint">API 환산 ${{ (cost.api_equiv_month || 0).toFixed(0) }} · {{ formatTokens(cost.total_tokens) }}</span>
            </div>
          </div>
          <div class="dash-costbar mt-3">
            <span class="dash-cost-opus" :style="{ width: (cost.pct && cost.pct.opus || 0) + '%' }"></span>
            <span class="dash-cost-sonnet" :style="{ width: (cost.pct && cost.pct.sonnet || 0) + '%' }"></span>
            <span class="dash-cost-haiku" :style="{ width: (cost.pct && cost.pct.haiku || 0) + '%' }"></span>
          </div>
          <div class="dash-cost-legend mt-2">
            <span class="text-faint w-100 mb-1">모델별 (API 환산)</span>
            <span><i class="dot dash-cost-opus"></i>Opus ${{ famCost('opus') }}</span>
            <span><i class="dot dash-cost-sonnet"></i>Sonnet ${{ famCost('sonnet') }}</span>
            <span><i class="dot dash-cost-haiku"></i>Haiku ${{ famCost('haiku') }}</span>
          </div>
        </div>
      </div>
      <div class="col-12 col-lg-6">
        <div class="card p-4 h-100">
          <h2 class="h6 mb-3"><i class="bi bi-activity me-1"></i>AI 가동현황 <span class="text-faint fw-normal small">최근 7일</span></h2>
          <div class="row text-center g-0">
            <div class="col-4">
              <div class="pd-stat-value" style="font-size:1.5rem">{{ activity.sessions || 0 }}</div>
              <div class="pd-stat-sub">세션</div>
            </div>
            <div class="col-4 border-start border-hairline">
              <div class="pd-stat-value" style="font-size:1.5rem">{{ formatTokens(activity.messages) }}</div>
              <div class="pd-stat-sub">메시지</div>
            </div>
            <div class="col-4 border-start border-hairline">
              <div class="pd-stat-value" style="font-size:1.5rem">{{ formatTokens(activity.tools) }}</div>
              <div class="pd-stat-sub">도구호출</div>
            </div>
          </div>
          <div class="mt-3 pt-3 border-top border-hairline">
            <h2 class="h6 mb-2">프로젝트별 AI 투입 Top5</h2>
            <div v-if="aiTop.length">
              <component v-for="p in aiTop" :key="p.project_key"
                :is="p.project_id ? 'router-link' : 'div'"
                :to="p.project_id ? ('/projects/' + p.project_id) : undefined"
                class="dash-rank-row text-decoration-none">
                <span class="dash-rank-name">{{ p.project_name || displayKey(p.project_key) }}</span>
                <span class="dash-rank-track"><span class="dash-rank-fill" :style="{ width: p.pct + '%' }"></span></span>
                <span class="dash-rank-val">{{ p.session_count }}세션</span>
              </component>
            </div>
            <p v-else class="text-muted small mb-0">세션 데이터가 없습니다.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 열린 이슈 (admin) -->
    <div v-if="admin && openIssues.length" class="card p-4">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h2 class="h6 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>열린 이슈</h2>
        <router-link to="/insights?seg=issues" class="small text-decoration-none">전체 보기 →</router-link>
      </div>
      <div class="pd-list">
        <router-link v-for="i in openIssues" :key="i.id"
          :to="'/projects/' + i.project_id + '?tab=journal'" class="pd-item">
          <span class="pd-item-dot" :class="'pd-dot--' + issueColor(i)"><i class="bi bi-exclamation-circle"></i></span>
          <div class="pd-item-body">
            <div class="pd-item-title">{{ i.title }}</div>
            <div class="pd-item-meta"><i class="bi bi-folder"></i> {{ i.project_name || '—' }}</div>
          </div>
          <div class="pd-item-right"><span :class="'badge bg-' + issueColor(i)">{{ severityLabel(i.severity) }}</span></div>
        </router-link>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: '홈',
  data() {
    return {
      summary: {},
      loading: true,
      admin: isAdmin(),
    }
  },
  computed: {
    inbox() { return this.summary.inbox || {} },
    cost() { return this.summary.ai_cost || {} },
    activity() { return this.summary.ai_activity || {} },
    openIssues() { return this.summary.open_issues_top || [] },
    recentActivities() { return this.summary.recent_activities || [] },
    activeProjects() {
      return (this.summary.active_projects || []).slice(0, 6)
    },
    autoEnabled() {
      return !!(this.summary.autonomy_enabled)
    },
    aiTop() {
      const list = this.summary.project_ai_top || []
      const max = Math.max(...list.map(p => p.session_count || 0), 1)
      return list.map(p => ({ ...p, pct: Math.round((p.session_count || 0) / max * 100) }))
    }
  },
  async mounted() {
    const { data, error } = await useApi('/api/dashboard')
    this.loading = false
    if (error) return
    this.summary = data
    // 자율 상태도 대시보드 응답에 포함하거나 별도 조회
    if (this.admin) {
      const { data: autoData } = await useApi('/api/lead/autonomy')
      if (autoData) this.summary = { ...this.summary, autonomy_enabled: autoData.enabled }
    }
  },
  methods: {
    famCost(fam) {
      const v = (this.cost.by_family && this.cost.by_family[fam]) || 0
      return v.toFixed(2)
    },
    issueColor(i) {
      if (i.status !== 'open') return 'success'
      return { critical: 'danger', high: 'danger', medium: 'warning', low: 'secondary' }[i.severity] || 'warning'
    },
    severityLabel(s) {
      return { critical: '치명', high: '높음', medium: '보통', low: '낮음' }[s] || '보통'
    },
    activityTitle(a) {
      const isJson = s => typeof s === 'string' && /^\s*[{\[]/.test(s)
      if (a.title && !isJson(a.title)) return a.title
      if (a.detail && !isJson(a.detail)) return String(a.detail).slice(0, 100)
      const MAP = {
        project_autonomy_update: '프로젝트 자율 설정 변경', project_update: '프로젝트 수정',
        project_create: '프로젝트 생성', cycle_proposal_create: '다음 단계 제안 생성',
        cycle_ingest: '자율 사이클 결과 반영', project_status_change: '라이프사이클 상태 변경',
        command_create: '명령 생성', execute: '실행', update: '수정',
      }
      return MAP[a.action] || String(a.action || '활동').replace(/_/g, ' ')
    },
    displayKey(key) {
      if (!key) return '—'
      return key.replace(/^g--workspace-/, '').replace(/-/g, ' ')
    },
    relativeTime(iso) {
      if (!iso) return '—'
      const diff = Date.now() - new Date(iso).getTime()
      const min = Math.floor(diff / 60000)
      if (min < 1) return '방금'
      if (min < 60) return `${min}분 전`
      const h = Math.floor(min / 60)
      if (h < 24) return `${h}시간 전`
      return `${Math.floor(h / 24)}일 전`
    },
    formatTokens,
  }
}
</script>
