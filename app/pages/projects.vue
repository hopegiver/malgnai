<template>
  <div>
    <!-- 페이지 헤더 -->
    <div class="d-flex justify-content-between align-items-center mb-4">
      <div>
        <h1 class="mb-0">프로젝트</h1>
        <small class="text-muted" v-if="!loading">
          총 {{ projects.length }}개<span v-if="search.trim() || activeFilter || kindFilter"> · {{ filteredProjects.length }}개 표시</span>
          <span v-if="activeCount > 0"> · 자율 가동 {{ activeCount }}개</span>
        </small>
      </div>
      <button class="btn btn-primary d-flex align-items-center gap-1" @click="openNewModal">
        <i class="bi bi-plus-lg"></i>
        <span class="d-none d-sm-inline">새 프로젝트</span>
      </button>
    </div>

    <!-- 필터 바: 유형 탭 → 상태 선택 → 검색 (높이 통일 = .project-filter-bar, base.css) -->
    <div class="project-filter-bar d-flex flex-wrap align-items-center gap-2 mb-4">
      <div class="btn-group" role="group">
        <button class="btn" :class="kindFilter === '' ? 'btn-primary' : 'btn-outline-secondary'" @click="setKindFilter('')">전체 유형</button>
        <button
          v-for="k in KIND_OPTIONS"
          :key="k.value"
          class="btn"
          :class="kindFilter === k.value ? 'btn-primary' : 'btn-outline-secondary'"
          @click="setKindFilter(k.value)">{{ k.label }}</button>
      </div>
      <select class="form-select" style="width:auto" v-model="activeFilter" aria-label="상태 필터">
        <option value="">전체 상태</option>
        <option value="active">진행</option>
        <option value="pending">대기</option>
        <option value="completed">완료</option>
        <option value="on_hold">보류</option>
      </select>
      <input
        class="form-control"
        style="width:180px"
        type="search"
        v-model="search"
        placeholder="이름 검색..."
        aria-label="프로젝트 이름 검색">
    </div>

    <!-- 로딩 스켈레톤 -->
    <div v-if="loading" class="row g-3">
      <div class="col-12 col-md-6 col-xl-4" v-for="n in 6" :key="n">
        <div class="card p-4" style="min-height:160px">
          <div class="skeleton-line" style="width:60%;height:16px;margin-bottom:8px"></div>
          <div class="skeleton-line" style="width:40%;height:12px;margin-bottom:16px"></div>
          <div class="skeleton-line" style="width:100%;height:6px;margin-bottom:8px"></div>
          <div class="skeleton-line" style="width:50%;height:12px"></div>
        </div>
      </div>
    </div>

    <!-- 프로젝트 카드 그리드 -->
    <div v-else-if="filteredProjects.length" class="row g-3">
      <div class="col-12 col-md-6 col-xl-4" v-for="p in filteredProjects" :key="p.id">
        <div class="project-card card h-100" @click="$router.push('/projects/' + p.id)" style="cursor:pointer">
          <!-- 카드 상단: 이름 + 자율 상태 -->
          <div class="d-flex justify-content-between align-items-start mb-1">
            <span class="fw-semibold text-truncate me-2" style="font-size:15px">{{ p.name }}</span>
            <span class="d-flex align-items-center gap-1 flex-shrink-0" :class="'text-' + activityTone(p)" style="font-size:12px">
              <span class="project-card-dot" :class="{ 'project-card-dot--live': p.activity_status === 'running' }"></span>
              {{ activityLabel(p) }}
            </span>
          </div>

          <!-- 상태 + 유형 + 에이전트 -->
          <div class="d-flex align-items-center gap-2 mb-2">
            <span class="badge" :class="'bg-' + statusColor(p.status) + '-subtle text-' + statusColor(p.status) + '-emphasis'" style="font-size:11px" title="라이프사이클 단계">{{ statusLabel(p.status) }}</span>
            <span class="badge" :style="{ color: kindMeta(p.kind).fg, backgroundColor: kindMeta(p.kind).bg, fontSize: '11px' }" title="프로젝트 유형">{{ kindLabel(p.kind) }}</span>
            <span v-if="p.lead_agent_name" class="text-faint" style="font-size:12px">
              <i class="bi bi-robot" style="font-size:10px"></i> {{ p.lead_agent_name }}
            </span>
          </div>

          <!-- 설명 -->
          <div v-if="p.description" class="text-muted text-truncate mb-3" style="font-size:13px">{{ p.description }}</div>

          <div class="mt-auto">
            <div class="border-top border-hairline pt-3">
              <!-- 마지막 활동 -->
              <div class="d-flex justify-content-between align-items-center">
                <span class="text-faint" style="font-size:12px">
                  <i class="bi bi-clock me-1"></i>{{ lastActivity(p) }}
                </span>
                <span class="text-primary text-decoration-none" style="font-size:12px">보기 →</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 빈 상태: 검색/필터 결과 없음 -->
    <div v-else-if="!loading && (search.trim() || activeFilter || kindFilter)" class="text-center py-5">
      <i class="bi bi-funnel d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
      <div class="fw-medium mb-1 text-muted">해당 조건의 프로젝트가 없습니다</div>
      <button class="btn btn-sm btn-outline-secondary mt-2" @click="resetFilter">필터 초기화</button>
    </div>

    <!-- 빈 상태: 프로젝트 없음 -->
    <div v-else-if="!loading" class="text-center py-5">
      <i class="bi bi-folder-plus d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
      <div class="fw-medium mb-1 text-muted">프로젝트가 없습니다</div>
      <div class="text-faint small mb-3">AI에게 첫 프로젝트를 맡겨 보세요</div>
      <button class="btn btn-primary btn-sm" @click="openNewModal">
        <i class="bi bi-plus-lg me-1"></i>첫 프로젝트 만들기
      </button>
    </div>

    <!-- 새 프로젝트 모달 -->
    <div v-if="showNewModal" class="modal-backdrop-custom" @click.self="showNewModal = false">
      <div class="modal-dialog-custom card p-4" style="max-width:520px;width:100%">
        <div class="d-flex justify-content-between align-items-center mb-4">
          <h5 class="mb-0">새 프로젝트</h5>
          <button class="btn-close" @click="showNewModal = false" aria-label="닫기"></button>
        </div>

        <form @submit.prevent="createProject">
          <div class="mb-3">
            <label class="form-label fw-medium">프로젝트명 <span class="text-danger">*</span></label>
            <input class="form-control font-monospace" v-model="form.name" placeholder="예: my-project" required maxlength="50" pattern="^[a-z0-9]+(-[a-z0-9]+)*$" :class="formErrors.name ? 'is-invalid' : ''">
            <div class="invalid-feedback">{{ formErrors.name }}</div>
            <div class="form-text">영문 소문자·숫자·하이픈(-)만, 공백 불가. <code>~/workspace/{{ form.name || '이름' }}</code> 폴더가 이 이름으로 생성됩니다.</div>
          </div>
          <div class="mb-3">
            <label class="form-label fw-medium">설명 (표시 이름)</label>
            <input class="form-control" v-model="form.description" placeholder="한 줄 설명 — 한글 표시 이름도 여기 (선택)" maxlength="500">
          </div>
          <div class="mb-3">
            <label class="form-label fw-medium">유형</label>
            <select class="form-select" v-model="form.kind">
              <option v-for="k in KIND_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</option>
            </select>
          </div>
          <div class="row g-3 mb-3">
            <div class="col-6">
              <label class="form-label fw-medium">담당 에이전트</label>
              <select class="form-select" v-model="form.lead_agent_name">
                <option value="">선택 안 함</option>
                <option v-for="a in agents" :key="a.name" :value="a.name">{{ a.name }}</option>
              </select>
            </div>
            <div class="col-6">
              <label class="form-label fw-medium">실행 주기</label>
              <select class="form-select" v-model="form.cadence">
                <option value="off">자동 실행 안 함</option>
                <option value="15min">15분마다</option>
                <option value="30min">30분마다</option>
                <option value="hourly">1시간마다</option>
                <option value="daily">매일</option>
              </select>
            </div>
          </div>
          <div class="mb-4 d-flex align-items-center gap-2">
            <div class="form-check form-switch mb-0">
              <input class="form-check-input" type="checkbox" role="switch" id="newAutoSwitch" v-model="form.autonomy_enabled" :disabled="!form.lead_agent_name" aria-pressed="form.autonomy_enabled">
              <label class="form-check-label" for="newAutoSwitch">자율 운영 즉시 시작</label>
            </div>
            <span v-if="form.autonomy_enabled && !form.lead_agent_name" class="text-danger small">에이전트를 먼저 선택하세요</span>
          </div>

          <div v-if="createError" class="alert alert-danger py-2 mb-3 small">{{ createError }}</div>

          <div class="d-flex gap-2 justify-content-end">
            <button type="button" class="btn btn-outline-secondary" @click="showNewModal = false">취소</button>
            <button type="submit" class="btn btn-primary" :disabled="creating">
              <span v-if="creating" class="spinner-border spinner-border-sm me-1"></span>
              프로젝트 만들기
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
// 프로젝트 유형(kind) 5종 — server/dao/init.js AUTONOMOUS_KINDS 와 값 일치(단일 소스는 서버, 여긴 표시용 라벨만).
const KIND_OPTIONS = [
  { value: 'dev', label: '개발' },
  { value: 'research', label: '리서치' },
  { value: 'marketing', label: '마케팅' },
  { value: 'proposal', label: '제안' },
  { value: 'internal_ops', label: '내부운영' },
]
const KIND_LABEL_MAP = Object.fromEntries(KIND_OPTIONS.map(k => [k.value, k.label]))
// 서버 server/lib/scaffold-project.js 의 PROJECT_NAME_RE 와 동일(단일 소스는 서버, 여긴 UX용 사전 검증).
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export default {
  title: '프로젝트',
  data() {
    return {
      projects: [],
      agents: [],
      loading: true,
      activeFilter: '',
      kindFilter: '',
      search: '',
      showNewModal: false,
      creating: false,
      createError: '',
      form: { name: '', description: '', kind: 'dev', lead_agent_name: '', cadence: 'off', autonomy_enabled: false },
      formErrors: {},
      KIND_OPTIONS,
    }
  },
  computed: {
    filteredProjects() {
      let list = this.projects
      if (this.activeFilter) list = list.filter(p => p.status === this.activeFilter)
      if (this.kindFilter) list = list.filter(p => p.kind === this.kindFilter)
      const q = this.search.trim().toLowerCase()
      if (q) list = list.filter(p => (p.name || '').toLowerCase().includes(q))
      return list
    },
    activeCount() {
      return this.projects.filter(p => p.autonomy_active).length
    }
  },
  async mounted() {
    await Promise.all([this.load(), this.loadAgents()])
  },
  methods: {
    async load() {
      this.loading = true
      const { data, error } = await useApi('/api/projects')
      this.loading = false
      if (error) return
      this.projects = data.projects || []
    },
    async loadAgents() {
      const { data } = await useApi('/api/agents')
      this.agents = data?.agents || []
    },
    setKindFilter(k) {
      this.kindFilter = k
    },
    resetFilter() {
      this.activeFilter = ''
      this.kindFilter = ''
      this.search = ''
    },
    openNewModal() {
      this.form = { name: '', description: '', kind: 'dev', lead_agent_name: '', cadence: 'off', autonomy_enabled: false }
      this.formErrors = {}
      this.createError = ''
      this.showNewModal = true
    },
    validateForm() {
      this.formErrors = {}
      const name = this.form.name.trim()
      if (!name) {
        this.formErrors.name = '프로젝트명을 입력하세요'
        return false
      }
      if (name.length < 2 || name.length > 50 || !NAME_RE.test(name)) {
        this.formErrors.name = '영문 소문자·숫자·하이픈(-)만 사용, 공백 불가 (예: my-project)'
        return false
      }
      return true
    },
    async createProject() {
      if (!this.validateForm()) return
      this.creating = true
      this.createError = ''
      const body = {
        name: this.form.name.trim(),
        description: this.form.description.trim() || undefined,
        kind: this.form.kind,
        lead_agent_name: this.form.lead_agent_name || undefined,
        cadence: this.form.cadence,
        autonomy_enabled: this.form.autonomy_enabled && !!this.form.lead_agent_name,
      }
      const { data, error } = await useApi('/api/projects', { method: 'POST', body: JSON.stringify(body) })
      this.creating = false
      if (error) {
        this.createError = error.message || '프로젝트 생성에 실패했습니다'
        return
      }
      this.showNewModal = false
      const id = data?.project?.id
      if (id) {
        this.$router.push('/projects/' + id)
      } else {
        await this.load()
      }
    },
    // 라이프사이클(사람이 정하는 단계). "진행중" → "진행"으로 완화해 실시간 가동상태와 혼동 방지.
    statusColor(s) {
      return { pending: 'secondary', active: 'primary', completed: 'success', on_hold: 'warning', deleted: 'danger' }[s] || 'secondary'
    },
    statusLabel(s) {
      return { pending: '대기', active: '진행', completed: '완료', on_hold: '보류', deleted: '삭제됨' }[s] || s
    },
    kindLabel(k) {
      return KIND_LABEL_MAP[k] || k
    },
    // 상태 배지(bootstrap 시맨틱 색)와 겹치지 않게 유형은 별도 팔레트(연한 배경+짙은 글자, act-cat-badge 톤과 동일 계열).
    kindMeta(k) {
      const M = {
        dev:          { fg: '#0075de', bg: 'rgba(0,117,222,0.10)' },
        research:     { fg: '#7a3ff2', bg: 'rgba(122,63,242,0.12)' },
        marketing:    { fg: '#b5540a', bg: 'rgba(221,91,0,0.12)' },
        proposal:     { fg: '#1f7d79', bg: 'rgba(42,157,153,0.14)' },
        internal_ops: { fg: '#5c636a', bg: 'rgba(108,117,125,0.14)' },
      }
      return M[k] || { fg: '#5c636a', bg: 'rgba(108,117,125,0.14)' }
    },
    // 가동 상태(서버 파생 activity_status). "지금 AI가 실제로 돌고 있나"의 유일한 표현.
    activityLabel(p) {
      return { running: '가동중', idle: '대기', stalled: '점검필요', off: '정지' }[p.activity_status] || '정지'
    },
    activityTone(p) {
      // 텍스트/도트 색 클래스. off=회색, running=녹색, idle=파랑, stalled=주황.
      return { running: 'success', idle: 'primary', stalled: 'warning', off: 'muted' }[p.activity_status] || 'muted'
    },
    lastActivity(p) {
      const ts = p.last_run_at || p.updated_at
      if (!ts) return '없음'
      const diff = Date.now() - new Date(ts).getTime()
      const min = Math.floor(diff / 60000)
      if (min < 1) return '방금 전'
      if (min < 60) return `${min}분 전`
      const h = Math.floor(min / 60)
      if (h < 24) return `${h}시간 전`
      const d = Math.floor(h / 24)
      return `${d}일 전`
    }
  }
}
</script>
