<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-4">
      <div>
        <h1 class="mb-0">대시보드</h1>
        <small class="text-muted" v-if="!loading && !error">
          내 프로젝트 {{ projects.length }}개<span v-if="statusFilter"> · {{ filteredProjects.length }}개 표시</span>
        </small>
      </div>
      <button class="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1" @click="load" :disabled="loading">
        <i class="bi" :class="loading ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'"></i>
        새로고침
      </button>
    </div>

    <!-- 필터 -->
    <div class="d-flex flex-wrap align-items-center gap-2 mb-4" v-if="!loading && !error && projects.length">
      <div class="btn-group" role="group">
        <button class="btn btn-sm" :class="statusFilter === '' ? 'btn-primary' : 'btn-outline-secondary'" @click="statusFilter = ''">전체</button>
        <button class="btn btn-sm" :class="statusFilter === 'active' ? 'btn-primary' : 'btn-outline-secondary'" @click="statusFilter = 'active'">진행</button>
        <button class="btn btn-sm" :class="statusFilter === 'archived' ? 'btn-primary' : 'btn-outline-secondary'" @click="statusFilter = 'archived'">보관</button>
      </div>
    </div>

    <!-- 로딩 스켈레톤 -->
    <div v-if="loading" class="row g-3">
      <div class="col-12 col-md-6 col-xl-4" v-for="n in 6" :key="n">
        <div class="card p-4" style="min-height:120px">
          <div class="skeleton-line" style="width:60%;height:16px;margin-bottom:10px"></div>
          <div class="skeleton-line" style="width:40%;height:12px;margin-bottom:16px"></div>
          <div class="skeleton-line" style="width:30%;height:20px"></div>
        </div>
      </div>
    </div>

    <!-- 에러 -->
    <div v-else-if="error" class="alert alert-warning d-flex justify-content-between align-items-center">
      <span><i class="bi bi-exclamation-triangle me-1"></i>{{ errorMessage }}</span>
      <button class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
    </div>

    <!-- 프로젝트 카드 그리드 -->
    <div v-else-if="filteredProjects.length" class="row g-3">
      <div class="col-12 col-md-6 col-xl-4" v-for="p in filteredProjects" :key="p.id">
        <div class="project-card card h-100" @click="$router.push('/projects/' + p.id)" style="cursor:pointer">
          <div class="d-flex justify-content-between align-items-start mb-2">
            <span class="fw-semibold text-truncate me-2" style="font-size:15px">{{ p.name }}</span>
            <span class="badge" :class="projectStatusMeta(p.status).cls">{{ projectStatusMeta(p.status).label }}</span>
          </div>
          <div v-if="p.project_key" class="text-faint text-truncate mb-2" style="font-size:12px">
            <i class="bi bi-tag me-1"></i>{{ p.project_key }}
          </div>
          <div class="mt-auto pt-3 border-top border-hairline">
            <span class="text-primary" style="font-size:12px">상세 보기 →</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 빈 상태: 필터 결과 없음 -->
    <div v-else-if="statusFilter" class="text-center py-5">
      <i class="bi bi-funnel d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
      <div class="fw-medium mb-1 text-muted">해당 조건의 프로젝트가 없습니다</div>
      <button class="btn btn-sm btn-outline-secondary mt-2" @click="statusFilter = ''">필터 초기화</button>
    </div>

    <!-- 빈 상태: 프로젝트 없음 -->
    <div v-else class="text-center py-5">
      <i class="bi bi-folder2 d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
      <div class="fw-medium mb-1 text-muted">아직 프로젝트가 없습니다</div>
      <div class="text-faint small">Claude Code에서 malgnai-hub 플러그인으로 작업을 기록하면 프로젝트가 자동으로 생성됩니다.</div>
    </div>
  </div>
</template>

<script>
export default {
  title: '대시보드 · malgnai-hub',
  data() {
    return {
      projects: [],
      loading: true,
      error: false,
      errorMessage: '',
      statusFilter: '',
    }
  },
  computed: {
    filteredProjects() {
      let list = this.projects
      if (this.statusFilter) list = list.filter((p) => p.status === this.statusFilter)
      return list
    },
  },
  async mounted() {
    await this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.error = false
      const { data, error } = await useApi('/api/projects')
      this.loading = false
      if (error) {
        this.error = true
        this.errorMessage = error?.message || '프로젝트 목록을 불러오지 못했습니다.'
        return
      }
      this.projects = data?.data || []
    },
    projectStatusMeta,
  },
}
</script>
