<template>
  <div>
    <h1 class="mb-3">활동 로그</h1>

    <!-- ===== 필터 바 ===== -->
    <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
      <div class="btn-group" role="group" aria-label="이력 범위">
        <button type="button" class="btn btn-sm" :class="level === 'work' ? 'btn-primary' : 'btn-outline-secondary'"
          @click="setLevel('work')"><i class="bi bi-person-workspace me-1"></i>작업이력</button>
        <button type="button" class="btn btn-sm" :class="level === 'all' ? 'btn-primary' : 'btn-outline-secondary'"
          @click="setLevel('all')"><i class="bi bi-list-ul me-1"></i>전체(시스템포함)</button>
      </div>
      <select v-model="category" class="form-select form-select-sm" style="width:auto" @change="reload">
        <option v-for="o in categoryOptions" :key="o.v" :value="o.v">{{ o.label }}</option>
      </select>
      <select v-model="agent" class="form-select form-select-sm" style="width:auto" @change="reload">
        <option value="">전체 에이전트</option>
        <option v-for="name in agentOptions" :key="name" :value="name">{{ name }}</option>
      </select>
    </div>

    <div v-if="error" class="alert alert-warning py-2 px-3 small d-flex justify-content-between align-items-center">
      <span><i class="bi bi-exclamation-triangle me-1"></i>활동을 불러오지 못했습니다: {{ error }}</span>
      <a href="#" class="text-decoration-none" @click.prevent="reload">다시 시도</a>
    </div>

    <div v-if="loading" class="text-center text-muted py-5">
      <span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...
    </div>
    <template v-else-if="groupedActivities.length">
      <div v-for="group in groupedActivities" :key="group.date">
        <!-- 날짜 헤더 -->
        <div class="act-date-header d-flex align-items-center gap-2 my-3">
          <span class="act-date-label small fw-semibold text-muted text-uppercase">{{ group.label }}</span>
          <div class="flex-grow-1" style="height:1px; background: var(--color-hairline)"></div>
        </div>
        <!-- 활동 아이템 -->
        <div v-for="a in group.items" :key="a.id"
             class="act-feed-item d-flex gap-3 py-2 border-bottom border-hairline"
             :class="{ 'act-telemetry': a.level === 'telemetry' }">
          <!-- 시간 -->
          <div class="act-feed-time text-faint text-nowrap small flex-shrink-0">{{ relTime(a.created_at) }}</div>
          <!-- 본문 -->
          <div class="flex-grow-1 min-w-0">
            <!-- 메타 행 -->
            <div class="d-flex align-items-center flex-wrap gap-1 mb-1">
              <span v-if="categoryMeta(a.category)" class="badge act-cat-badge"
                :style="{ color: categoryMeta(a.category).fg, backgroundColor: categoryMeta(a.category).bg }">
                <i class="bi" :class="categoryMeta(a.category).icon"></i>{{ categoryMeta(a.category).label }}
              </span>
              <span class="small text-muted fw-medium">{{ a.agent_name }}</span>
              <span v-if="a.project_name || a.project_id" class="text-faint small">·</span>
              <router-link v-if="a.project_id" :to="'/projects/' + a.project_id" class="small text-decoration-none text-muted">
                {{ a.project_name || a.project_id }}
              </router-link>
            </div>
            <!-- 제목 -->
            <div class="act-title fw-medium text-truncate" :title="a.detail || ''">{{ displayTitle(a) }}</div>
            <!-- 결과 + 산출물 -->
            <div class="d-flex flex-wrap align-items-center gap-2 mt-1">
              <span v-if="resultMeta(a.result)" class="badge" :class="resultMeta(a.result).cls">
                {{ resultMeta(a.result).label }}
              </span>
              <template v-if="links(a).length">
                <a v-for="(ln, i) in links(a)" :key="i" href="#"
                   class="badge bg-light act-link text-decoration-none"
                   @click.prevent="openLink(ln, a)">
                  <i class="bi" :class="ln.url ? 'bi-box-arrow-up-right' : 'bi-file-earmark-text'"></i>
                  {{ ln.label || (ln.path ? shortPath(ln.path) : ln.url) }}
                </a>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>
    <div v-else-if="!loading" class="empty-state py-5">
      <i class="bi bi-clock-history empty-state-icon"></i>
      <div class="empty-state-title">
        {{ (category || agent) ? '조건에 맞는 활동이 없습니다.' : '아직 기록된 활동이 없습니다.' }}
      </div>
      <div class="empty-state-hint">
        <template v-if="category || agent">
          필터를 바꾸거나 <a href="#" @click.prevent="resetFilters">초기화</a>해 보세요.
        </template>
        <template v-else>
          에이전트가 작업을 수행하면 활동이 자동으로 쌓입니다.
        </template>
      </div>
    </div>

    <div v-if="!loading && hasMore" class="text-center mt-3">
      <button class="btn btn-outline-secondary btn-sm" :disabled="loadingMore" @click="loadMore">
        <span v-if="loadingMore" class="spinner-border spinner-border-sm me-2"></span>더 보기
      </button>
    </div>

    <!-- 파일 미리보기 모달 -->
    <div v-if="viewFile" class="modal-backdrop-custom" @click.self="closeFile">
      <div class="modal-card card shadow">
        <div class="d-flex justify-content-between align-items-center p-3 border-bottom border-hairline">
          <div class="text-truncate">
            <i class="bi bi-file-earmark-text me-2"></i>
            <span class="fw-medium">{{ viewFile.name }}</span>
          </div>
          <button class="btn-close" @click="closeFile" aria-label="닫기"></button>
        </div>
        <div class="modal-body-scroll p-0">
          <div v-if="fileLoading" class="text-muted p-4">
            <span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...
          </div>
          <div v-else-if="fileError" class="alert alert-warning m-3">{{ fileError }}</div>
          <pre v-else class="file-preview mb-0">{{ viewFile.content }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* 활동 로그 전용 (vue-zero: plain <style> — scoped 금지 규칙 준수) */
.act-feed-item { transition: background-color 0.1s; }
.act-feed-item:hover { background-color: var(--color-canvas-soft); }
.act-telemetry { opacity: 0.55; font-size: 0.8125rem; }
.act-date-header { }
.act-date-label { letter-spacing: 0.04em; }
.act-feed-time { min-width: 4rem; padding-top: 0.125rem; }
.act-cat-badge { display: inline-flex; align-items: center; gap: 0.25rem; }
.act-title { font-weight: 500; word-break: break-word; }
.act-action { font-size: 0.7rem; text-transform: none; }
.act-target { color: var(--color-ink-muted); word-break: break-all; background: var(--color-canvas-soft); padding: 0.1em 0.35em; border-radius: var(--rounded-sm); }
.act-link { font-weight: 500; }
.act-link i { margin-right: 0.2rem; }

/* 파일 미리보기 모달 (프로젝트 상세와 동일 규칙 — 이 페이지 단독 로드 대비) */
.modal-backdrop-custom { position: fixed; inset: 0; z-index: 1050; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; padding: 1rem; }
.modal-backdrop-custom .modal-card { width: 100%; max-width: 900px; max-height: 85vh; display: flex; flex-direction: column; }
.modal-backdrop-custom .modal-body-scroll { overflow: auto; }
.file-preview { white-space: pre-wrap; word-break: break-word; font-size: .8125rem; line-height: 1.5; padding: 1rem 1.25rem; }
</style>

<script>
export default {
  title: '활동 로그',
  data() {
    return {
      activities: [],
      loading: true,
      loadingMore: false,
      error: '',
      // 필터
      level: 'work',       // 'work' = 기본(work+audit) / 'all' = include_telemetry
      category: '',
      agent: '',
      agentOptions: [],
      categoryOptions: [
        { v: '', label: '전체 카테고리' },
        { v: 'plan', label: '기획' },
        { v: 'design', label: '설계' },
        { v: 'build', label: '구현' },
        { v: 'verify', label: '검증' },
        { v: 'decision', label: '결정' },
        { v: 'deploy', label: '배포' },
        { v: 'ops', label: '운영' },
        { v: 'system', label: '시스템' },
      ],
      // 페이지네이션
      limit: 50,
      hasMore: false,
      // 파일 프리뷰
      viewFile: null,
      fileLoading: false,
      fileError: '',
    }
  },
  async mounted() {
    await this.load()
    this.loadAgents()
  },
  computed: {
    groupedActivities() {
      const now = new Date()
      const todayStr = now.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
      const yest = new Date(now); yest.setDate(yest.getDate() - 1)
      const yesterdayStr = yest.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
      const groups = []
      const groupMap = {}
      for (const a of this.activities) {
        const d = new Date(a.created_at)
        const dateStr = d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
        let label = dateStr
        if (dateStr === todayStr) label = '오늘'
        else if (dateStr === yesterdayStr) label = '어제'
        else {
          const diffMs = now - d
          const diffDays = Math.floor(diffMs / 86400000)
          label = diffDays + '일 전'
        }
        if (!groupMap[dateStr]) {
          groupMap[dateStr] = { date: dateStr, label, items: [] }
          groups.push(groupMap[dateStr])
        }
        groupMap[dateStr].items.push(a)
      }
      return groups
    }
  },
  methods: {
    relTime(iso) {
      if (!iso) return ''
      const diff = Date.now() - new Date(iso).getTime()
      const min = Math.floor(diff / 60000)
      if (min < 1) return '방금'
      if (min < 60) return min + '분 전'
      const hr = Math.floor(min / 60)
      if (hr < 24) return hr + '시간 전'
      return Math.floor(hr / 24) + '일 전'
    },
    buildQuery(limit) {
      const p = new URLSearchParams()
      if (this.level === 'all') p.set('include_telemetry', '1')
      // level === 'work' 는 파라미터 없음 = 서버 기본(work+audit).
      if (this.category) p.set('category', this.category)
      if (this.agent) p.set('agent_name', this.agent)
      p.set('limit', String(limit))
      const qs = p.toString()
      return '/api/activities' + (qs ? '?' + qs : '')
    },
    async load() {
      this.loading = true
      this.limit = 50
      const { data, error } = await useApi(this.buildQuery(this.limit))
      this.loading = false
      if (error) { this.error = error; return }
      this.error = ''
      this.activities = data.activities || []
      this.hasMore = this.activities.length >= this.limit
    },
    async reload() { await this.load() },
    setLevel(l) {
      if (this.level === l) return
      this.level = l
      this.load()
    },
    resetFilters() {
      this.category = ''
      this.agent = ''
      this.load()
    },
    async loadMore() {
      this.loadingMore = true
      const next = this.limit + 50
      const { data, error } = await useApi(this.buildQuery(next))
      this.loadingMore = false
      if (error) { this.error = error; return }
      this.limit = next
      this.activities = data.activities || []
      this.hasMore = this.activities.length >= this.limit
    },
    async loadAgents() {
      const { data } = await useApi('/api/agents')
      const names = (data && data.agents ? data.agents : []).map(a => a.name).filter(Boolean)
      // 활동에 등장하나 레지스트리에 없는 이름(system 등)도 옵션에 포함.
      const seen = new Set(names)
      for (const a of this.activities) {
        if (a.agent_name && !seen.has(a.agent_name)) { seen.add(a.agent_name); names.push(a.agent_name) }
      }
      this.agentOptions = names.sort()
    },
    categoryMeta(c) { return activityCategoryMeta(c) },
    resultMeta(r) { return activityResultMeta(r) },
    links(a) { return parseActivityLinks(a.links_json) },
    // 제목 표시: title/detail 이 원시 JSON(‘{’·‘[’ 로 시작)이면 노출하지 않고 action 을 사람말로 변환한다.
    //   (자율 설정 변경 등 일부 이벤트가 goal/kpi_json 페이로드를 title 에 그대로 실어 보내던 게 눈에 거슬림 — UX Top3)
    isJsonLike(s) { return typeof s === 'string' && /^\s*[{\[]/.test(s) },
    humanizeAction(action) {
      if (!action) return '활동'
      const MAP = {
        project_autonomy_update: '프로젝트 자율 설정 변경',
        project_update: '프로젝트 수정',
        project_create: '프로젝트 생성',
        cycle_proposal_create: '다음 단계 제안 생성',
        cycle_proposal_lock: '제안 잠금(중복 방지)',
        cycle_ingest: '자율 사이클 결과 반영',
        cycle_parse_fail: '사이클 출력 파싱 실패',
        instant_dispatch_error: '즉시 실행 오류',
        instant_dispatch_reject: '실행 거부(보안 게이트)',
        instant_dispatch_skip: '즉시 실행 건너뜀',
        resume_requeue: '세션 재개 재큐잉',
        resume_requeue_skip: '세션 재개 상한 도달',
        command_create: '명령 생성',
        execute: '실행', test: '테스트', create: '생성', update: '수정',
      }
      if (MAP[action]) return MAP[action]
      return String(action).replace(/_/g, ' ')  // 미매핑 snake_case → 공백
    },
    displayTitle(a) {
      if (a.title && !this.isJsonLike(a.title)) return a.title
      if (a.detail && !this.isJsonLike(a.detail)) return String(a.detail).slice(0, 120)
      return this.humanizeAction(a.action)
    },
    shortPath(p) {
      const parts = String(p).split('/')
      return parts[parts.length - 1] || p
    },
    openLink(ln, a) {
      if (ln.url) { window.open(ln.url, '_blank', 'noopener'); return }
      if (ln.path && a.project_id) { this.openFile(a.project_id, ln.path, ln.label || this.shortPath(ln.path)); return }
      // project_id 없는 path 링크는 열 수 없음(전역 활동엔 project_id NULL 존재 가능) → 무동작.
    },
    async openFile(projectId, path, name) {
      this.viewFile = { name: name || path, content: '' }
      this.fileLoading = true
      this.fileError = ''
      const { data, error } = await useApi('/api/projects/' + projectId + '/file?file=' + encodeURIComponent(path))
      this.fileLoading = false
      if (error || !data) { this.fileError = '파일을 읽지 못했습니다: ' + (error || '알 수 없는 오류'); return }
      this.viewFile.content = data.content
    },
    closeFile() { this.viewFile = null; this.fileError = '' },
    formatDate(iso) {
      if (!iso) return ''
      return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    },
  }
}
</script>
