<template>
  <div>
    <div class="mb-3">
      <router-link to="/" class="text-muted small">&larr; 대시보드</router-link>
    </div>

    <!-- 프로젝트 로딩/에러 -->
    <div v-if="loading" class="card p-4 placeholder-glow">
      <span class="placeholder col-4 mb-2" style="height:1.5rem"></span>
      <span class="placeholder col-6"></span>
    </div>
    <div v-else-if="error" class="alert alert-warning d-flex justify-content-between align-items-center">
      <span><i class="bi bi-exclamation-triangle me-1"></i>{{ errorMessage }}</span>
      <button class="btn btn-sm btn-outline-secondary" @click="loadProject">다시 시도</button>
    </div>

    <template v-else-if="project">
      <!-- 헤더 -->
      <div class="d-flex justify-content-between align-items-start mb-3 flex-wrap gap-2">
        <div class="min-w-0">
          <h1 class="mb-1 text-truncate">{{ project.name }}</h1>
          <div class="text-muted small">
            <span v-if="project.project_key"><i class="bi bi-tag me-1"></i>{{ project.project_key }}</span>
            <span v-if="repositoryName" class="ms-2"><i class="bi bi-diagram-3 me-1"></i>{{ repositoryName }}</span>
          </div>
        </div>
        <div class="d-flex align-items-center gap-2 flex-shrink-0">
          <span class="badge" :class="projectStatusMeta(project.status).cls">{{ projectStatusMeta(project.status).label }}</span>
          <span v-if="project.classification === 'confidential'" class="badge bg-danger"><i class="bi bi-lock-fill me-1"></i>기밀</span>
        </div>
      </div>

      <!-- 탭 -->
      <div class="pd-tabs-wrap mb-4">
        <ul class="nav pd-tabs nav-tabs-scroll" role="tablist">
          <li class="nav-item" role="presentation">
            <button class="nav-link" type="button" :class="{ active: tab === 'overview' }" @click="selectTab('overview')">
              <i class="bi bi-speedometer2 pd-tab-icon"></i>개요
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" type="button" :class="{ active: tab === 'wbs' }" @click="selectTab('wbs')">
              <i class="bi bi-list-check pd-tab-icon"></i>WBS
              <span v-if="wbs.summary" class="pd-tab-count">{{ wbs.summary.total }}</span>
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" type="button" :class="{ active: tab === 'decisions' }" @click="selectTab('decisions')">
              <i class="bi bi-signpost-split pd-tab-icon"></i>결정
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" type="button" :class="{ active: tab === 'issues' }" @click="selectTab('issues')">
              <i class="bi bi-exclamation-triangle pd-tab-icon"></i>이슈
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" type="button" :class="{ active: tab === 'works' }" @click="selectTab('works')">
              <i class="bi bi-journal-text pd-tab-icon"></i>작업이력
            </button>
          </li>
        </ul>
      </div>

      <!-- ============ 개요 탭 (project_states) ============ -->
      <div v-show="tab === 'overview'">
        <div v-if="state" class="card p-4 mb-3">
          <div class="d-flex justify-content-between align-items-start mb-3 flex-wrap gap-2">
            <div>
              <div class="pd-kpi-label text-muted small">현재 단계</div>
              <div class="fw-semibold" style="font-size:1.1rem">{{ state.phase || '미지정' }}</div>
            </div>
            <span v-if="state.health" class="badge" :class="healthMeta(state.health).cls">{{ healthMeta(state.health).label }}</span>
          </div>
          <div v-if="state.progress !== null && state.progress !== undefined" class="mb-3">
            <div class="d-flex justify-content-between small text-muted mb-1">
              <span>진행률</span><span>{{ state.progress }}%</span>
            </div>
            <div class="pd-progress-track">
              <div class="pd-progress-fill" :style="{ width: state.progress + '%' }"></div>
            </div>
          </div>
          <div class="row g-3">
            <div class="col-12 col-md-6" v-if="state.current_goal">
              <div class="small text-muted mb-1">목표</div>
              <div>{{ state.current_goal }}</div>
            </div>
            <div class="col-12 col-md-6" v-if="state.current_work">
              <div class="small text-muted mb-1">현재 작업</div>
              <div>{{ state.current_work }}</div>
            </div>
            <div class="col-12 col-md-6" v-if="state.next_action">
              <div class="small text-muted mb-1">다음 행동</div>
              <div>{{ state.next_action }}</div>
            </div>
            <div class="col-12 col-md-6" v-if="state.blocker_summary">
              <div class="small text-danger mb-1">막힌 것</div>
              <div>{{ state.blocker_summary }}</div>
            </div>
          </div>
          <div class="d-flex flex-wrap gap-3 mt-3 pt-3 border-top border-hairline small text-faint">
            <span v-if="state.active_branch"><i class="bi bi-git me-1"></i>{{ state.active_branch }}</span>
            <span v-if="state.latest_commit" class="font-monospace">{{ state.latest_commit.slice(0, 12) }}</span>
            <span v-if="state.updated_at">갱신 {{ formatDate(state.updated_at) }}</span>
          </div>
        </div>
        <div v-else class="text-center py-5">
          <i class="bi bi-clipboard-x d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
          <div class="fw-medium mb-1 text-muted">아직 기록된 상태가 없습니다</div>
          <div class="text-faint small">MCP <code>update_project_state</code> 호출로 채워집니다.</div>
        </div>
      </div>

      <!-- ============ WBS 탭 ============ -->
      <div v-show="tab === 'wbs'">
        <div v-if="wbs.loading" class="text-muted text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...</div>
        <div v-else-if="wbs.error" class="alert alert-warning py-2 px-3 small">{{ wbs.error }}</div>
        <template v-else>
          <div v-if="wbs.summary" class="d-flex flex-wrap gap-3 mb-3 small">
            <span>전체 {{ wbs.summary.total }}</span>
            <span class="text-muted">계획 {{ wbs.summary.planned }}</span>
            <span class="text-primary">진행중 {{ wbs.summary.inProgress ?? wbs.summary.in_progress }}</span>
            <span class="text-success">완료 {{ wbs.summary.done }}</span>
            <span v-if="wbs.summary.delayed" class="text-danger fw-semibold">지연 {{ wbs.summary.delayed }}</span>
          </div>
          <div v-if="wbsTree.length" class="card">
            <div v-for="item in wbsTree" :key="item.id" class="wbs-row d-flex align-items-center gap-2 px-3 py-2 border-bottom border-hairline"
              :style="{ paddingLeft: (12 + item.depth * 20) + 'px' }">
              <i class="bi" :class="item.depth === 0 ? 'bi-flag' : 'bi-dash-lg'" style="opacity:.5"></i>
              <div class="flex-grow-1 min-w-0">
                <div class="d-flex align-items-center gap-2">
                  <span class="text-truncate" :class="item.depth === 0 ? 'fw-semibold' : ''">{{ item.title }}</span>
                  <span class="badge" :class="wbsStatusMeta(item.bucket).cls">{{ wbsStatusMeta(item.bucket).label }}</span>
                </div>
                <div class="small text-faint d-flex flex-wrap gap-2 mt-1">
                  <span v-if="item.responsible_team"><i class="bi bi-people me-1"></i>{{ item.responsible_team }}</span>
                  <span v-if="item.assignee_agent_name"><i class="bi bi-robot me-1"></i>{{ item.assignee_agent_name }}</span>
                  <span v-if="item.end_date">~{{ item.end_date }}</span>
                </div>
              </div>
              <div class="wbs-progress flex-shrink-0 d-flex align-items-center gap-2" style="width:120px">
                <div class="pd-progress-track flex-grow-1" style="height:6px">
                  <div class="pd-progress-fill" :style="{ width: (item.progress ?? 0) + '%' }"></div>
                </div>
                <small class="text-faint" style="width:2.5rem;text-align:right">{{ item.progress ?? 0 }}%</small>
              </div>
            </div>
          </div>
          <div v-else class="text-center py-5">
            <i class="bi bi-list-check d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
            <div class="fw-medium mb-1 text-muted">등록된 WBS 항목이 없습니다</div>
            <div class="text-faint small">MCP <code>wbs_add</code>/<code>wbs_bulk_add</code> 호출로 채워집니다.</div>
          </div>
        </template>
      </div>

      <!-- ============ 결정 탭 ============ -->
      <div v-show="tab === 'decisions'">
        <div v-if="decisions.loading" class="text-muted text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...</div>
        <div v-else-if="decisions.error" class="alert alert-warning py-2 px-3 small">{{ decisions.error }}</div>
        <div v-else-if="decisions.items.length" class="pd-list">
          <div v-for="d in decisions.items" :key="d.id" class="pd-item pd-item--static">
            <div class="pd-item-body">
              <div class="d-flex align-items-center gap-2 mb-1">
                <span class="pd-item-title">{{ d.title }}</span>
                <span class="badge" :class="decisionImportanceMeta(d.importance).cls">{{ decisionImportanceMeta(d.importance).label }}</span>
              </div>
              <div class="small text-muted">{{ d.summary }}</div>
              <div v-if="d.reason" class="small text-faint mt-1">이유: {{ d.reason }}</div>
            </div>
            <div class="pd-item-right"><small class="text-faint text-nowrap">{{ formatDate(d.created_at) }}</small></div>
          </div>
        </div>
        <div v-else class="text-center py-5">
          <i class="bi bi-signpost-split d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
          <div class="fw-medium text-muted">기록된 결정이 없습니다</div>
        </div>
      </div>

      <!-- ============ 이슈 탭 ============ -->
      <div v-show="tab === 'issues'">
        <div class="d-flex justify-content-end mb-2">
          <div class="form-check form-switch mb-0">
            <input class="form-check-input" type="checkbox" id="issueOpenOnly" v-model="issues.openOnly" @change="loadIssues">
            <label class="form-check-label small text-muted" for="issueOpenOnly">열림만</label>
          </div>
        </div>
        <div v-if="issues.loading" class="text-muted text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...</div>
        <div v-else-if="issues.error" class="alert alert-warning py-2 px-3 small">{{ issues.error }}</div>
        <div v-else-if="issues.items.length" class="pd-list">
          <div v-for="i in issues.items" :key="i.id" class="pd-item pd-item--static">
            <div class="pd-item-body">
              <div class="d-flex align-items-center gap-2 mb-1">
                <span class="pd-item-title">{{ i.title }}</span>
                <span class="badge" :class="issueSeverityMeta(i.severity).cls">{{ issueSeverityMeta(i.severity).label }}</span>
                <span class="badge" :class="issueStatusMeta(i.status).cls">{{ issueStatusMeta(i.status).label }}</span>
              </div>
              <div class="small text-muted">{{ i.description }}</div>
              <div v-if="i.related_file" class="small text-faint font-monospace mt-1">{{ i.related_file }}</div>
              <div v-if="i.status === 'resolved' && i.resolution_note" class="small text-success mt-1">해결: {{ i.resolution_note }}</div>
            </div>
            <div class="pd-item-right"><small class="text-faint text-nowrap">{{ formatDate(i.created_at) }}</small></div>
          </div>
        </div>
        <div v-else class="text-center py-5">
          <i class="bi bi-check2-circle d-block mb-3" style="font-size:2.5rem;color:var(--color-success)"></i>
          <div class="fw-medium text-muted">{{ issues.openOnly ? '열린 이슈가 없습니다' : '기록된 이슈가 없습니다' }}</div>
        </div>
      </div>

      <!-- ============ 작업이력 탭 (works) ============ -->
      <div v-show="tab === 'works'">
        <div v-if="works.loading" class="text-muted text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...</div>
        <div v-else-if="works.error" class="alert alert-warning py-2 px-3 small">{{ works.error }}</div>
        <div v-else-if="works.items.length" class="pd-list">
          <div v-for="w in works.items" :key="w.id" class="pd-item pd-item--static">
            <span class="pd-item-dot pd-dot--info"><i class="bi bi-journal-text"></i></span>
            <div class="pd-item-body">
              <div class="d-flex align-items-center gap-2 mb-1">
                <span class="pd-item-title">{{ w.title }}</span>
                <span v-if="w.category" class="badge bg-light text-dark">{{ w.category }}</span>
              </div>
              <div v-if="w.detail" class="small text-muted">{{ w.detail }}</div>
              <div v-if="w.target_ref" class="small text-faint font-monospace mt-1">{{ w.target_ref }}</div>
            </div>
            <div class="pd-item-right"><small class="text-faint text-nowrap">{{ formatDate(w.created_at) }}</small></div>
          </div>
        </div>
        <div v-else class="text-center py-5">
          <i class="bi bi-journal-text d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
          <div class="fw-medium text-muted">기록된 작업이력이 없습니다</div>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
export default {
  title: '프로젝트 상세 · malgnai-hub',
  data() {
    return {
      loading: true,
      error: false,
      errorMessage: '',
      project: null,
      tab: 'overview',
      decisions: { items: [], loading: false, error: '', loaded: false },
      issues: { items: [], loading: false, error: '', loaded: false, openOnly: true },
      works: { items: [], loading: false, error: '', loaded: false },
      wbs: { items: [], summary: null, loading: false, error: '', loaded: false },
    }
  },
  computed: {
    // GET /api/projects/:id 응답 봉투 형태(단일 객체 vs { data: {...} })가 불확실해 방어적으로 정규화.
    // repository/state는 조인 여부에 따라 중첩되거나 평탄화됐을 수 있어 둘 다 수용.
    repositoryName() {
      return this.project?.repository?.name || this.project?.repository_name || ''
    },
    state() {
      return this.project?.state || (this.project?.phase !== undefined ? this.project : null)
    },
    wbsTree() {
      const items = this.wbs.items
      if (!items.length) return []
      const byParent = new Map()
      for (const raw of items) {
        const it = this.normalizeWbsItem(raw)
        const key = it.parent_id || '__root__'
        if (!byParent.has(key)) byParent.set(key, [])
        byParent.get(key).push(it)
      }
      for (const list of byParent.values()) {
        list.sort((a, b) => (a.seq - b.seq) || String(a.created_at || '').localeCompare(String(b.created_at || '')))
      }
      const out = []
      const walk = (parentKey) => {
        for (const it of byParent.get(parentKey) || []) {
          out.push(it)
          walk(it.id)
        }
      }
      walk('__root__')
      return out
    },
  },
  async mounted() {
    await this.loadProject()
    if (this.project) await this.loadWbs() // 탭 카운트 배지 표시를 위해 개요와 함께 선로딩
  },
  methods: {
    async loadProject() {
      this.loading = true
      this.error = false
      const id = this.$route.params.id
      const { data, error } = await useApi(`/api/projects/${id}`)
      this.loading = false
      if (error) {
        this.error = true
        this.errorMessage = error?.code === 'NOT_FOUND' ? '프로젝트를 찾을 수 없습니다.' : (error?.message || '프로젝트를 불러오지 못했습니다.')
        return
      }
      this.project = data?.data ?? data
    },
    selectTab(name) {
      this.tab = name
      if (name === 'decisions' && !this.decisions.loaded) this.loadDecisions()
      if (name === 'issues' && !this.issues.loaded) this.loadIssues()
      if (name === 'works' && !this.works.loaded) this.loadWorks()
      if (name === 'wbs' && !this.wbs.loaded) this.loadWbs()
    },
    async loadDecisions() {
      this.decisions.loading = true
      this.decisions.error = ''
      const id = this.$route.params.id
      const { data, error } = await useApi(`/api/projects/${id}/decisions?limit=30`)
      this.decisions.loading = false
      this.decisions.loaded = true
      if (error) { this.decisions.error = error?.message || '결정 목록을 불러오지 못했습니다.'; return }
      this.decisions.items = data?.data || []
    },
    async loadIssues() {
      this.issues.loading = true
      this.issues.error = ''
      const id = this.$route.params.id
      const statusParam = this.issues.openOnly ? 'open' : 'all'
      const { data, error } = await useApi(`/api/projects/${id}/issues?status=${statusParam}&limit=30`)
      this.issues.loading = false
      this.issues.loaded = true
      if (error) { this.issues.error = error?.message || '이슈 목록을 불러오지 못했습니다.'; return }
      this.issues.items = data?.data || []
    },
    async loadWorks() {
      this.works.loading = true
      this.works.error = ''
      const id = this.$route.params.id
      const { data, error } = await useApi(`/api/projects/${id}/activities?limit=30`)
      this.works.loading = false
      this.works.loaded = true
      if (error) { this.works.error = error?.message || '작업이력을 불러오지 못했습니다.'; return }
      this.works.items = data?.data || []
    },
    async loadWbs() {
      // 참고: docs/api.md §5.4에는 WBS 전용 REST 라우트가 명시되어 있지 않다(WBS 4종 MCP 도구 중
      // wbs_list만 존재하고 REST는 문서화 안 됨). decisions/issues/activities와 동일한 라우팅
      // 패턴(/api/projects/:id/*)을 그대로 따른다고 가정해 /wbs 를 호출한다 — 백엔드가 이 경로로
      // 노출하지 않으면 아래 에러 상태로 안전하게 표시된다(devops 통합 단계에서 확정 필요, 완료
      // 보고에 명시).
      this.wbs.loading = true
      this.wbs.error = ''
      const id = this.$route.params.id
      const { data, error } = await useApi(`/api/projects/${id}/wbs`)
      this.wbs.loading = false
      this.wbs.loaded = true
      if (error) { this.wbs.error = error?.message || 'WBS 목록을 불러오지 못했습니다.'; return }
      const payload = data?.data ?? data
      this.wbs.items = payload?.items || []
      this.wbs.summary = payload?.summary || null
    },
    // wbs_list 출력(mcp-tools.md §4.7)은 camelCase, REST 하우스 스타일(api.md)은 snake_case —
    // REST 전용 라우트가 문서화되지 않아 어느 쪽으로 나올지 불확실하므로 둘 다 수용해 정규화한다.
    normalizeWbsItem(it) {
      return {
        id: it.id,
        parent_id: it.parent_id ?? it.parentId ?? null,
        depth: it.depth ?? 0,
        seq: it.seq ?? 0,
        title: it.title,
        bucket: it.bucket ?? it.status,
        progress: it.progress ?? it.computed_progress ?? it.computedProgress ?? 0,
        responsible_team: it.responsible_team ?? it.responsibleTeam ?? '',
        assignee_agent_name: it.assignee_agent_name ?? it.assigneeAgentName ?? '',
        end_date: it.end_date ?? it.endDate ?? '',
        created_at: it.created_at ?? it.createdAt ?? '',
      }
    },
    healthMeta(h) {
      const M = {
        normal: { label: '정상', cls: 'bg-success' },
        warning: { label: '주의', cls: 'bg-warning' },
        critical: { label: '위험', cls: 'bg-danger' },
      }
      return M[h] || { label: h, cls: 'bg-secondary' }
    },
    projectStatusMeta,
    decisionImportanceMeta,
    issueSeverityMeta,
    issueStatusMeta,
    wbsStatusMeta,
    formatDate,
  },
}
</script>

<style>
.pd-tabs-wrap { display: flex; align-items: flex-end; border-bottom: 1px solid var(--color-hairline); background-color: var(--color-surface); border-radius: var(--rounded-md) var(--rounded-md) 0 0; margin-bottom: 1.5rem; }
.pd-tabs { border-bottom: none; gap: 0.125rem; background-color: transparent; border-radius: 0; flex: 1; min-width: 0; }
.pd-tabs .nav-link {
  position: relative; display: inline-flex; align-items: center; gap: 0.4rem;
  color: var(--color-ink-muted); font-size: 0.9375rem; font-weight: 500;
  border: none; background: none; border-radius: var(--rounded-sm) var(--rounded-sm) 0 0;
  padding: 0.625rem 0.875rem; margin-bottom: -1px;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.pd-tabs .nav-link::after {
  content: ""; position: absolute; left: 0.5rem; right: 0.5rem; bottom: -1px;
  height: 2px; border-radius: 2px 2px 0 0; background-color: var(--color-primary);
  transform: scaleX(0); transform-origin: center; transition: transform 0.2s ease;
}
.pd-tabs .nav-link:hover { color: var(--color-ink); background-color: var(--color-canvas-soft); }
.pd-tabs .nav-link.active { color: var(--color-primary); font-weight: 600; background: none; }
.pd-tabs .nav-link.active::after { transform: scaleX(1); background-color: var(--color-primary); }
.pd-tab-icon { font-size: 1rem; opacity: 0.85; }
.pd-tab-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.25rem; height: 1.25rem; padding: 0 0.375rem; margin-left: 2px;
  font-size: 0.6875rem; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--color-ink-muted); background-color: var(--color-canvas-soft);
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-full);
}
.wbs-row:last-child { border-bottom: none !important; }
@media (max-width: 575.98px) {
  .pd-tabs .nav-link { padding: 0.625rem 0.625rem; font-size: 0.875rem; }
  .wbs-progress { width: 80px !important; }
}
</style>
