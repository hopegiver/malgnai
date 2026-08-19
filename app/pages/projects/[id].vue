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

      <!-- ============ 개요 탭 (state, project_get_context가 매 호출마다 즉석 계산 — mcp-tools.md §4.1) ============ -->
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
            <div class="col-12 col-md-6" v-if="state.currentWork">
              <div class="small text-muted mb-1">현재 작업</div>
              <div class="pd-state-text markdown-body" v-html="renderMarkdown(state.currentWork, { breaks: true })"></div>
            </div>
            <div class="col-12 col-md-6" v-if="state.nextAction">
              <div class="small text-muted mb-1">다음 행동</div>
              <div class="pd-state-text markdown-body" v-html="renderMarkdown(state.nextAction, { breaks: true })"></div>
            </div>
            <div class="col-12 col-md-6" v-if="state.blockerSummary">
              <div class="small text-danger mb-1">막힌 것</div>
              <div class="pd-state-text markdown-body" v-html="renderMarkdown(state.blockerSummary, { breaks: true })"></div>
            </div>
          </div>
        </div>
        <div v-else class="text-center py-5">
          <i class="bi bi-clipboard-x d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
          <div class="fw-medium mb-1 text-muted">아직 기록된 상태가 없습니다</div>
          <div class="text-faint small">작업이력(work_record)이 쌓이면 자동으로 채워집니다.</div>
        </div>
      </div>

      <!-- ============ WBS 탭 ============ -->
      <div v-show="tab === 'wbs'">
        <div v-if="wbs.loading" class="text-muted text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...</div>
        <div v-else-if="wbs.error" class="alert alert-warning py-2 px-3 small">{{ wbs.error }}</div>
        <template v-else>
          <div v-if="wbs.summary" class="d-flex flex-wrap gap-2 mb-3">
            <button type="button" class="pd-wbs-chip" :class="{ active: wbsFilter === 'all' }" @click="wbsFilter = 'all'">
              전체 <b>{{ wbs.summary.total }}</b>
            </button>
            <button type="button" class="pd-wbs-chip" :class="{ active: wbsFilter === 'planned' }" @click="wbsFilter = 'planned'">
              계획 <b>{{ wbs.summary.planned }}</b>
            </button>
            <button type="button" class="pd-wbs-chip" :class="{ active: wbsFilter === 'in_progress' }" @click="wbsFilter = 'in_progress'">
              진행중 <b>{{ wbs.summary.inProgress ?? wbs.summary.in_progress }}</b>
            </button>
            <button type="button" class="pd-wbs-chip" :class="{ active: wbsFilter === 'done' }" @click="wbsFilter = 'done'">
              완료 <b>{{ wbs.summary.done }}</b>
            </button>
            <button v-if="wbs.summary.delayed" type="button" class="pd-wbs-chip pd-wbs-chip--danger" :class="{ active: wbsFilter === 'delayed' }" @click="wbsFilter = 'delayed'">
              지연 <b>{{ wbs.summary.delayed }}</b>
            </button>
          </div>
          <div v-if="wbsTree.length" class="card pd-wbs">
            <div class="pd-wbs-header">
              <div>작업명</div>
              <div>책임</div>
              <div>담당</div>
              <div>시작~종료</div>
              <div>완료일</div>
              <div>진행률</div>
            </div>
            <template v-if="filteredWbsGroups.length">
              <div v-for="group in filteredWbsGroups" :key="group.step.id" class="pd-wbs-group">
                <div class="pd-wbs-step" role="button" tabindex="0" @click="toggleStep(group.step.id)" @keydown.enter="toggleStep(group.step.id)">
                  <i class="bi pd-wbs-step-chevron" :class="isStepExpanded(group.step.id) ? 'bi-chevron-down' : 'bi-chevron-right'"></i>
                  <span class="pd-wbs-step-badge">Step</span>
                  <span class="pd-wbs-step-title text-truncate">{{ group.step.title }}</span>
                  <span v-if="group.count" class="pd-wbs-step-summary">({{ group.count }}개 · {{ group.avgProgress }}%)</span>
                  <span class="badge ms-auto flex-shrink-0" :class="wbsStatusMeta(group.step.bucket).cls">{{ wbsStatusMeta(group.step.bucket).label }}</span>
                </div>
                <div v-show="isStepExpanded(group.step.id)">
                  <div v-for="item in group.children" :key="item.id" class="pd-wbs-item">
                    <div class="pd-wbs-cell pd-wbs-cell--title" :style="{ paddingLeft: ((item.depth - 1) * 16) + 'px' }">
                      <i class="bi bi-dash-lg pd-wbs-dash"></i>
                      <span class="text-truncate">{{ item.title }}</span>
                      <span class="badge flex-shrink-0" :class="wbsStatusMeta(item.bucket).cls">{{ wbsStatusMeta(item.bucket).label }}</span>
                    </div>
                    <div class="pd-wbs-cell pd-wbs-cell--resp"><i class="bi bi-people"></i>{{ item.responsible_team || '-' }}</div>
                    <div class="pd-wbs-cell pd-wbs-cell--assignee"><i class="bi bi-robot"></i>{{ item.assignee_agent_name || '-' }}</div>
                    <div class="pd-wbs-cell pd-wbs-cell--dates">{{ item.start_date || '-' }} ~ {{ item.end_date || '-' }}</div>
                    <div class="pd-wbs-cell pd-wbs-cell--completed">{{ item.completed_date || '-' }}</div>
                    <div class="pd-wbs-cell pd-wbs-cell--progress">
                      <div class="pd-progress-track flex-grow-1" style="height:6px">
                        <div class="pd-progress-fill" :style="{ width: (item.progress ?? 0) + '%' }"></div>
                      </div>
                      <small class="text-faint">{{ item.progress ?? 0 }}%</small>
                    </div>
                  </div>
                </div>
              </div>
            </template>
            <div v-else class="text-center py-4 text-faint small">선택한 상태의 항목이 없습니다.</div>
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
          <div ref="decisionsSentinel" class="pd-load-sentinel">
            <div v-if="decisions.loadingMore" class="text-muted text-center py-3 small"><span class="spinner-border spinner-border-sm me-2"></span>더 불러오는 중...</div>
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
            <input class="form-check-input" type="checkbox" id="issueOpenOnly" v-model="issues.openOnly" @change="loadIssues()">
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
          <div ref="issuesSentinel" class="pd-load-sentinel">
            <div v-if="issues.loadingMore" class="text-muted text-center py-3 small"><span class="spinner-border spinner-border-sm me-2"></span>더 불러오는 중...</div>
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
          <div ref="worksSentinel" class="pd-load-sentinel">
            <div v-if="works.loadingMore" class="text-muted text-center py-3 small"><span class="spinner-border spinner-border-sm me-2"></span>더 불러오는 중...</div>
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
    const validTabs = ['overview', 'wbs', 'decisions', 'issues', 'works']
    const initialTab = validTabs.includes(this.$route.query.tab) ? this.$route.query.tab : 'overview'
    return {
      loading: true,
      error: false,
      errorMessage: '',
      project: null,
      tab: initialTab,
      decisions: { items: [], loading: false, error: '', loaded: false, nextCursor: null, loadingMore: false },
      issues: { items: [], loading: false, error: '', loaded: false, openOnly: true, nextCursor: null, loadingMore: false },
      works: { items: [], loading: false, error: '', loaded: false, nextCursor: null, loadingMore: false },
      wbs: { items: [], summary: null, loading: false, error: '', loaded: false },
      wbsFilter: 'all',
      wbsCollapsedSteps: {},
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
    // wbsTree(depth-first 평탄화)를 depth===0(Step) 경계로 다시 묶어 그룹 헤더+하위 항목 렌더에 쓴다.
    // wbsTree 자체(트리 조립·정렬)는 건드리지 않고, 이미 완성된 배열을 순서 그대로 순회만 한다.
    wbsGroups() {
      const tree = this.wbsTree
      const groups = []
      let current = null
      for (const item of tree) {
        if (item.depth === 0 || !current) {
          current = { step: item, children: [] }
          groups.push(current)
        } else {
          current.children.push(item)
        }
      }
      return groups.map((g) => {
        const progresses = g.children.length ? g.children.map((c) => c.progress ?? 0) : [g.step.progress ?? 0]
        const avgProgress = Math.round(progresses.reduce((a, b) => a + b, 0) / progresses.length)
        return { step: g.step, children: g.children, count: g.children.length, avgProgress }
      })
    },
    // 상단 필터 칩의 로컬 필터링(REST /wbs 라우트가 상태 필터 파라미터를 지원하는지 문서상
    // 확인되지 않아 프론트에서 처리). Step 자체가 필터에 맞으면 그룹 전체를, 아니면 필터에
    // 맞는 하위 항목만 남기고 둘 다 없으면 그룹을 통째로 숨긴다.
    filteredWbsGroups() {
      if (this.wbsFilter === 'all') return this.wbsGroups
      const matches = (it) => it.bucket === this.wbsFilter
      return this.wbsGroups
        .map((g) => (matches(g.step) ? g : { ...g, children: g.children.filter(matches) }))
        .filter((g) => matches(g.step) || g.children.length)
    },
  },
  async mounted() {
    await this.loadProject()
    if (this.project) await this.loadWbs() // 탭 카운트 배지 표시를 위해 개요와 함께 선로딩
    if (this.tab === 'decisions') await this.loadDecisions()
    if (this.tab === 'issues') await this.loadIssues()
    if (this.tab === 'works') await this.loadWorks()
  },
  beforeUnmount() {
    // catalog/index.vue의 _sectionObserver 정리 패턴과 동일 — 탭별 무한스크롤 옵저버를 인스턴스
    // 프로퍼티(this._loadMoreObservers)로 들고 있다가 컴포넌트 해제 시 전부 disconnect한다.
    if (this._loadMoreObservers) {
      Object.values(this._loadMoreObservers).forEach((o) => o.disconnect())
      this._loadMoreObservers = {}
    }
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
      this.$router.replace({ query: name === 'overview' ? {} : { tab: name } })
      if (name === 'decisions' && !this.decisions.loaded) this.loadDecisions()
      if (name === 'issues' && !this.issues.loaded) this.loadIssues()
      if (name === 'works' && !this.works.loaded) this.loadWorks()
      if (name === 'wbs' && !this.wbs.loaded) this.loadWbs()
    },
    // 결정/이슈/작업이력 3개 탭 공통 무한스크롤 로더. `more=false`(기본, 최초 로드/필터 변경)면
    // 기존 배열·커서를 비우고 처음부터 다시 받고, `more=true`(sentinel이 트리거)면 저장된
    // nextCursor로 이어붙인다. 이미 로딩 중이거나(loadingMore) 더 없으면(nextCursor null) more
    // 요청은 조용히 무시한다 — server/api/events.js의 { data, next_cursor } 커서 페이지네이션
    // 계약(next_cursor는 ULID, null이면 끝) 공통 사용.
    async loadEventPage(state, endpoint, baseParams, more) {
      if (more) {
        if (state.loadingMore || !state.nextCursor) return
        state.loadingMore = true
      } else {
        state.loading = true
        state.error = ''
        state.items = []
        state.nextCursor = null
      }
      const params = new URLSearchParams(baseParams)
      params.set('limit', '10')
      if (more && state.nextCursor) params.set('cursor', state.nextCursor)
      const { data, error } = await useApi(`${endpoint}?${params.toString()}`)
      state.loading = false
      state.loadingMore = false
      state.loaded = true
      if (error) { state.error = error?.message || '목록을 불러오지 못했습니다.'; return }
      const page = data?.data || []
      state.items = more ? [...state.items, ...page] : page
      state.nextCursor = data?.next_cursor ?? null
    },
    async loadDecisions(more = false) {
      const id = this.$route.params.id
      await this.loadEventPage(this.decisions, `/api/projects/${id}/decisions`, {}, more)
      this.$nextTick(() => this.setupLoadMoreObserver('decisions', 'decisionsSentinel', this.decisions, () => this.loadDecisions(true)))
    },
    async loadIssues(more = false) {
      const id = this.$route.params.id
      const statusParam = this.issues.openOnly ? 'open' : 'all'
      await this.loadEventPage(this.issues, `/api/projects/${id}/issues`, { status: statusParam }, more)
      this.$nextTick(() => this.setupLoadMoreObserver('issues', 'issuesSentinel', this.issues, () => this.loadIssues(true)))
    },
    async loadWorks(more = false) {
      const id = this.$route.params.id
      await this.loadEventPage(this.works, `/api/projects/${id}/activities`, {}, more)
      this.$nextTick(() => this.setupLoadMoreObserver('works', 'worksSentinel', this.works, () => this.loadWorks(true)))
    },
    // catalog/index.vue의 IntersectionObserver 패턴(this._sectionObserver) 재사용 — 탭별로 별도
    // 인스턴스(this._loadMoreObservers[key])를 두고, sentinel이 뷰포트에 들어오면 loadFn()을 호출한다.
    // 더 없으면(nextCursor null) 아예 옵저버를 설치하지 않아 트리거 자체가 발생하지 않게 한다.
    setupLoadMoreObserver(key, refName, state, loadFn) {
      if (!this._loadMoreObservers) this._loadMoreObservers = {}
      if (this._loadMoreObservers[key]) {
        this._loadMoreObservers[key].disconnect()
        delete this._loadMoreObservers[key]
      }
      if (!state.nextCursor) return
      const el = this.$refs[refName]
      const target = Array.isArray(el) ? el[0] : el
      if (!target) return
      const observer = new IntersectionObserver(
        (entries) => { if (entries.some((e) => e.isIntersecting)) loadFn() },
        { rootMargin: '200px 0px', threshold: 0 }
      )
      observer.observe(target)
      this._loadMoreObservers[key] = observer
    },
    async loadWbs() {
      // GET /api/projects/:id/wbs 실존 확인(server/api/events.js:72, server/lib/wbs.js wbsList
      // 재사용). 기본 호출(파라미터 없음)은 완료(bucket='done') 항목을 응답에서 제외한다
      // (server/lib/wbs.js: status 미지정 && !includeDone 이면 done 필터링) — 반면 summary는
      // 항상 전체 카운트를 포함해 계산되므로, include_done=true 없이 부르면 "완료" 필터 칩의
      // summary 카운트와 실제 표시 목록이 어긋난다. 상단 필터 칩은 서버 재호출 없이 프론트에서
      // wbs.items를 로컬 필터링(filteredWbsGroups)하므로, 최초 로드 시 항상 전체 트리를 받아둔다.
      this.wbs.loading = true
      this.wbs.error = ''
      const id = this.$route.params.id
      const { data, error } = await useApi(`/api/projects/${id}/wbs?include_done=true`)
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
        start_date: it.start_date ?? it.startDate ?? '',
        end_date: it.end_date ?? it.endDate ?? '',
        completed_date: it.completed_date ?? it.completedDate ?? '',
        created_at: it.created_at ?? it.createdAt ?? '',
      }
    },
    // Step(depth===0) 그룹 접기/펼치기. 미기록 상태는 기본 펼침으로 취급한다.
    isStepExpanded(stepId) {
      return this.wbsCollapsedSteps[stepId] !== true
    },
    toggleStep(stepId) {
      this.wbsCollapsedSteps = { ...this.wbsCollapsedSteps, [stepId]: this.isStepExpanded(stepId) }
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
    renderMarkdown,
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
.pd-state-text { white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
/* 카드 안의 작은 값 필드라 base.css의 기본 .markdown-body 헤딩 크기(h1 1.5rem 등)는 과하다 —
   여기서만 축소하고 상하 여백도 좁힌다. 마지막 <p>는 카드 padding과 이중 여백이 안 생기게 0으로. */
.pd-state-text.markdown-body { white-space: normal; }
.pd-state-text.markdown-body h1,
.pd-state-text.markdown-body h2,
.pd-state-text.markdown-body h3 { font-size: 1rem; margin-top: 0.75em; margin-bottom: 0.35em; }
.pd-state-text.markdown-body h1:first-child,
.pd-state-text.markdown-body h2:first-child,
.pd-state-text.markdown-body h3:first-child { margin-top: 0; }
.pd-state-text.markdown-body p:last-child { margin-bottom: 0; }
/* 결정/이슈/작업이력 무한스크롤 sentinel — 데이터가 없을 때(로딩중 아님)는 내용 없이 옵저버
   대상으로만 존재하므로 최소 높이를 둬 레이아웃에서 항상 관측 가능하게 한다. */
.pd-load-sentinel { min-height: 1px; }
.pd-tab-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.25rem; height: 1.25rem; padding: 0 0.375rem; margin-left: 2px;
  font-size: 0.6875rem; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--color-ink-muted); background-color: var(--color-canvas-soft);
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-full);
}

/* ============ WBS 탭: 필터 칩 ============ */
.pd-wbs-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 12px; font-size: var(--font-size-sm); line-height: 1.4;
  color: var(--color-ink-muted); background-color: var(--color-surface);
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-full);
  cursor: pointer; transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.pd-wbs-chip b { font-weight: 600; font-variant-numeric: tabular-nums; }
.pd-wbs-chip:hover { background-color: var(--color-surface-hover); color: var(--color-ink); }
.pd-wbs-chip.active { color: var(--color-brand); background-color: var(--color-brand-soft); border-color: var(--color-brand); font-weight: 600; }
.pd-wbs-chip--danger.active { color: var(--color-danger-text); background-color: var(--color-danger-soft); border-color: var(--color-danger); }

/* ============ WBS 탭: Step 그룹 + 하위 항목 테이블 ============ */
.pd-wbs { overflow: hidden; }
.pd-wbs-header {
  display: none;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs); font-weight: 600; color: var(--color-ink-faint);
  border-bottom: 1px solid var(--color-hairline);
  text-transform: uppercase; letter-spacing: 0.02em;
}
.pd-wbs-group + .pd-wbs-group { border-top: 1px solid var(--color-hairline); }
.pd-wbs-step {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-3); cursor: pointer; user-select: none;
  background-color: var(--color-canvas-soft);
  border-bottom: 1px solid var(--color-hairline);
  transition: background-color 0.15s ease;
}
.pd-wbs-step:hover { background-color: var(--color-surface-hover); }
.pd-wbs-step-chevron { color: var(--color-ink-faint); font-size: 0.8125rem; flex-shrink: 0; }
.pd-wbs-step-badge {
  flex-shrink: 0; display: inline-flex; align-items: center;
  padding: 2px 10px; font-size: var(--font-size-xs); font-weight: 700;
  color: var(--color-brand); background-color: var(--color-brand-soft);
  border-radius: var(--rounded-full);
}
.pd-wbs-step-title { font-weight: 600; color: var(--color-ink); min-width: 0; }
.pd-wbs-step-summary { flex-shrink: 0; font-size: var(--font-size-sm); font-weight: 400; color: var(--color-ink-muted); }
.pd-wbs-item {
  display: flex; flex-direction: column; gap: 4px;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-hairline);
}
.pd-wbs-group > div > .pd-wbs-item:last-child { border-bottom: none; }
.pd-wbs-cell { display: flex; align-items: center; gap: 4px; font-size: var(--font-size-xs); color: var(--color-ink-faint); min-width: 0; }
.pd-wbs-cell--title { font-size: var(--font-size-base); color: var(--color-ink); gap: 8px; min-width: 0; }
.pd-wbs-cell--title .text-truncate { min-width: 0; flex: 1 1 auto; }
.pd-wbs-dash { color: var(--color-ink-faint); flex-shrink: 0; }
.pd-wbs-cell--progress { flex-direction: row; }
.pd-wbs-cell--progress .pd-progress-track { max-width: 120px; }
.pd-wbs-cell--progress small { flex-shrink: 0; width: 2.5rem; text-align: right; }

@media (min-width: 768px) {
  /* 고정 px 컬럼은 768px 근방(태블릿)에서 title 칸을 거의 0으로 짓눌러 제목이 사실상
     안 보이는 문제가 실측(768 스크린샷)에서 확인됐다 — minmax()로 각 컬럼에 최소폭만
     보장하고 남는 폭은 비례 배분해 좁은 화면에서도 title이 절대 으스러지지 않게 한다. */
  .pd-wbs-header {
    display: grid;
    grid-template-columns: minmax(140px, 2.2fr) minmax(64px, 0.8fr) minmax(64px, 0.8fr) minmax(110px, 1.1fr) minmax(76px, 0.7fr) minmax(96px, 1fr);
    column-gap: var(--space-3);
  }
  .pd-wbs-item {
    display: grid;
    grid-template-columns: minmax(140px, 2.2fr) minmax(64px, 0.8fr) minmax(64px, 0.8fr) minmax(110px, 1.1fr) minmax(76px, 0.7fr) minmax(96px, 1fr);
    align-items: center;
    column-gap: var(--space-3);
  }
  .pd-wbs-cell--resp, .pd-wbs-cell--assignee, .pd-wbs-cell--dates, .pd-wbs-cell--completed { font-size: var(--font-size-sm); }
}
@media (max-width: 575.98px) {
  .pd-tabs .nav-link { padding: 0.625rem 0.625rem; font-size: 0.875rem; }
  .pd-wbs-step-summary { display: none; }
  .pd-wbs-chip { padding: 3px 10px; font-size: var(--font-size-xs); }
}
</style>
