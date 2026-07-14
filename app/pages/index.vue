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

    <!-- [C2] 내 자율 프로젝트 현황 (전체 사용자 — 본인 소유/공유 프로젝트 기준) -->
    <div v-if="myAutoProjects.length" class="mb-4">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h2 class="h6 mb-0"><i class="bi bi-broadcast me-1"></i>내 자율 프로젝트 현황</h2>
        <span class="badge bg-success-subtle text-success-emphasis">오늘 비용 ${{ totalCostToday.toFixed(2) }}</span>
      </div>
      <div class="row g-2">
        <div class="col-12 col-md-6 col-xl-4" v-for="p in myAutoProjects" :key="p.id">
          <div class="card home-auto-card" @click="$router.push('/projects/' + p.id)" style="cursor:pointer">
            <div class="d-flex justify-content-between align-items-start mb-2">
              <span class="fw-semibold text-truncate me-2">{{ p.name }}</span>
              <span v-if="p.pending_approvals > 0" class="badge bg-warning text-dark flex-shrink-0">승인대기 {{ p.pending_approvals }}</span>
            </div>
            <div class="d-flex align-items-center gap-2 mb-2">
              <span class="badge bg-secondary-subtle text-secondary-emphasis">{{ projectStatusLabel(p.status) }}</span>
              <span v-if="p.last_cycle_status" :class="'badge bg-' + cycleColor(p.last_cycle_status)">{{ cycleLabel(p.last_cycle_status) }}</span>
            </div>
            <div class="home-auto-grid">
              <div>
                <div class="text-faint" style="font-size:11px">오늘 비용</div>
                <div class="small">{{ p.cost_today_usd != null ? '$' + p.cost_today_usd.toFixed(2) : '—' }}</div>
              </div>
              <div>
                <div class="text-faint" style="font-size:11px">다음 실행</div>
                <div class="small">{{ p.next_run_at ? relativeTime(p.next_run_at) : '—' }}</div>
              </div>
              <div>
                <div class="text-faint" style="font-size:11px">마지막 실행</div>
                <div class="small">{{ p.last_run_at ? relativeTime(p.last_run_at) : '—' }}</div>
              </div>
            </div>
          </div>
        </div>
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
          <div class="card home-proj-card" @click="$router.push('/projects/' + p.id)" style="cursor:pointer" :class="{ 'border-primary border-2': p.autonomy_active }">
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
      admin: isSuperAdmin(),
      myAutoProjects: [],
    }
  },
  computed: {
    inbox() { return this.summary.inbox || {} },
    openIssues() { return this.summary.open_issues_top || [] },
    recentActivities() { return this.summary.recent_activities || [] },
    activeProjects() {
      return (this.summary.active_projects || []).slice(0, 6)
    },
    autoEnabled() {
      return !!(this.summary.autonomy_enabled)
    },
    totalCostToday() {
      return this.myAutoProjects.reduce((sum, p) => sum + (p.cost_today_usd || 0), 0)
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
    // 내 자율 프로젝트 현황(전체 사용자) — 본인 소유/공유 프로젝트 기준(H-3로 이미 스코프됨),
    // 실패해도 대시보드 전체엔 영향 없음. /workspaces는 cost_today_usd 등 사이클 통계를 안 주므로
    // 대신 /lead/status(projects[])를 쓴다 — autonomy.vue와 동일 소스, 필드 그대로 재사용 가능.
    const { data: statusData } = await useApi('/api/lead/status')
    if (statusData) this.myAutoProjects = statusData.projects || []
  },
  methods: {
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
    relativeTime(iso) {
      // 과거(활동·최근실행)뿐 아니라 미래(다음 실행 예정)도 표현한다.
      if (!iso) return '—'
      const diff = Date.now() - new Date(iso).getTime()
      const abs = Math.abs(diff)
      const future = diff < 0
      const min = Math.floor(abs / 60000)
      if (min < 1) return '방금'
      if (min < 60) return future ? `${min}분 후` : `${min}분 전`
      const h = Math.floor(min / 60)
      if (h < 24) return future ? `${h}시간 후` : `${h}시간 전`
      return future ? `${Math.floor(h / 24)}일 후` : `${Math.floor(h / 24)}일 전`
    },
    cycleColor(s) {
      return { done: 'success', failed: 'danger', running: 'info', claimed: 'info', queued: 'secondary', approved: 'primary' }[s] || 'secondary'
    },
    cycleLabel(s) {
      return { done: '완료', failed: '실패', running: '실행 중', claimed: '실행 중', queued: '대기', approved: '승인됨', rejected: '반려', expired: '만료' }[s] || s || '—'
    },
    projectStatusLabel(s) {
      return { planning: '기획', design: '설계', development: '개발', testing: '테스트', active: '진행', paused: '중단', done: '완료', archived: '보관' }[s] || s || '진행'
    },
    formatTokens,
  }
}
</script>

<style>
.home-auto-card { padding: 1rem; transition: box-shadow 0.15s, border-color 0.15s; }
.home-auto-card:hover { border-color: var(--color-primary); box-shadow: var(--shadow-soft, 0 4px 16px rgba(0,0,0,0.08)); }
.home-auto-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
</style>
