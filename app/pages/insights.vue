<template>
  <div>
    <h1 class="mb-1">인사이트</h1>
    <p class="text-muted mb-4">전체 프로젝트의 결정·이슈·메모리를 한곳에서</p>

    <!-- 세그먼트 토글 -->
    <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
      <div class="btn-group pd-subseg" role="group">
        <button type="button" class="btn btn-sm" :class="seg==='decisions'?'btn-primary':'btn-outline-secondary'" @click="setSeg('decisions')">
          <i class="bi bi-signpost-split me-1"></i>결정
        </button>
        <button type="button" class="btn btn-sm" :class="seg==='issues'?'btn-primary':'btn-outline-secondary'" @click="setSeg('issues')">
          <i class="bi bi-exclamation-triangle me-1"></i>이슈
        </button>
        <button type="button" class="btn btn-sm" :class="seg==='memories'?'btn-primary':'btn-outline-secondary'" @click="setSeg('memories')">
          <i class="bi bi-bookmark me-1"></i>메모리
        </button>
      </div>
    </div>

    <!-- 필터 바 -->
    <div class="d-flex flex-wrap gap-2 mb-3">
      <select v-model="filter.project_id" class="form-select form-select-sm w-auto" @change="reload">
        <option value="">전체 프로젝트</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <select v-if="seg==='issues'" v-model="filter.status" class="form-select form-select-sm w-auto" @change="reload">
        <option value="open">열림만</option>
        <option value="">전체</option>
        <option value="resolved">해결됨</option>
      </select>
      <select v-if="seg==='issues'" v-model="filter.severity" class="form-select form-select-sm w-auto" @change="reload">
        <option value="">모든 위험도</option>
        <option value="critical">치명</option>
        <option value="high">높음</option>
        <option value="medium">보통</option>
        <option value="low">낮음</option>
      </select>
      <select v-if="seg==='memories'" v-model="filter.memory_type" class="form-select form-select-sm w-auto" @change="reload">
        <option value="">모든 타입</option>
        <option v-for="t in memoryTypes" :key="t" :value="t">{{ t }}</option>
      </select>
      <span class="ms-auto align-self-center small text-muted">{{ items.length }}건</span>
    </div>

    <!-- 로딩 -->
    <div v-if="busy" class="text-muted small py-4">
      <span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...
    </div>

    <!-- 빈 상태 -->
    <div v-else-if="!items.length" class="empty-state card p-5">
      <i class="bi empty-state-icon" :class="segIcon"></i>
      <div class="empty-state-title">조건에 맞는 {{ segLabel }}이 없습니다.</div>
    </div>

    <!-- 결정 -->
    <template v-else-if="seg==='decisions'">
      <div v-for="d in items" :key="d.id" class="card p-3 mb-2">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div class="min-w-0">
            <div class="fw-semibold">{{ d.title }}</div>
            <div v-if="d.summary" class="ins-body mt-1">{{ d.summary }}</div>
            <div v-if="d.reason" class="text-faint small mt-1">이유: {{ d.reason }}</div>
          </div>
          <span class="badge bg-light text-dark flex-shrink-0">{{ d.project_name || '—' }}</span>
        </div>
        <div class="text-faint mt-2" style="font-size:0.6875rem">{{ formatDate(d.created_at) }}</div>
      </div>
    </template>

    <!-- 이슈 -->
    <template v-else-if="seg==='issues'">
      <div v-for="i in items" :key="i.id" class="card p-3 mb-2 ins-issue" :class="'ins-issue--' + issueColor(i)">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div class="min-w-0">
            <div class="d-flex align-items-center gap-2">
              <span :class="'badge bg-' + issueColor(i)">{{ i.status==='open' ? severityLabel(i.severity) : '해결' }}</span>
              <span class="fw-semibold">{{ i.title }}</span>
            </div>
            <div v-if="i.description" class="ins-body mt-1">{{ i.description }}</div>
            <div v-if="i.related_file" class="text-faint small font-monospace mt-1">{{ i.related_file }}</div>
          </div>
          <router-link :to="'/projects/' + i.project_id + '?tab=context'" class="badge bg-light text-dark flex-shrink-0 text-decoration-none">{{ i.project_name || '—' }} →</router-link>
        </div>
        <div class="text-faint mt-2" style="font-size:0.6875rem">{{ formatDate(i.created_at) }}</div>
      </div>
    </template>

    <!-- 메모리 -->
    <template v-else>
      <div v-for="m in items" :key="m.id" class="card p-3 mb-2">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div class="min-w-0">
            <div class="d-flex align-items-center gap-2">
              <span v-if="m.memory_type" class="badge bg-light text-dark">{{ m.memory_type }}</span>
              <span class="fw-semibold">{{ m.title }}</span>
            </div>
            <div v-if="m.content" class="ins-body mt-1">{{ m.content }}</div>
            <div v-if="m.tags" class="text-faint small mt-1">#{{ m.tags }}</div>
          </div>
          <span class="badge bg-light text-dark flex-shrink-0">{{ m.project_name || '—' }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
export default {
  title: '인사이트',
  data() {
    return {
      seg: 'issues', // 경영 모니터링 1순위 = 열린 이슈
      busy: false,
      items: [],
      projects: [],
      memoryTypes: ['user', 'feedback', 'project', 'reference', 'lesson'],
      filter: { project_id: '', status: 'open', severity: '', memory_type: '' }
    }
  },
  computed: {
    segLabel() { return { decisions: '결정', issues: '이슈', memories: '메모리' }[this.seg] },
    segIcon() {
      return { decisions: 'bi-signpost-split', issues: 'bi-exclamation-triangle', memories: 'bi-bookmark' }[this.seg]
    }
  },
  async mounted() {
    // 프로젝트 목록(필터용)
    const { data } = await useApi('/api/projects')
    if (data) this.projects = (data.projects || []).map(p => ({ id: p.id, name: p.name }))
    // ?seg= 딥링크
    const q = this.$route.query.seg
    if (q && ['decisions', 'issues', 'memories'].includes(q)) this.seg = q
    await this.reload()
  },
  methods: {
    setSeg(s) {
      if (s === this.seg) return
      this.seg = s
      if (this.$route.query.seg !== s) this.$router.replace({ query: { ...this.$route.query, seg: s } }).catch(() => {})
      // 이슈 진입 시 기본 열림만
      if (s === 'issues' && !this.filter.status) this.filter.status = 'open'
      this.reload()
    },
    async reload() {
      this.busy = true
      const f = this.filter
      const qs = []
      if (f.project_id) qs.push('project_id=' + f.project_id)
      qs.push('limit=200')
      let url = ''
      if (this.seg === 'decisions') {
        url = '/api/context/decisions?' + qs.join('&')
      } else if (this.seg === 'issues') {
        if (f.status) qs.push('status=' + f.status)
        if (f.severity) qs.push('severity=' + f.severity)
        url = '/api/context/issues?' + qs.join('&')
      } else {
        if (f.memory_type) qs.push('memory_type=' + f.memory_type)
        url = '/api/context/memories?' + qs.join('&')
      }
      const { data } = await useApi(url)
      this.busy = false
      if (!data) { this.items = []; return }
      this.items = data[this.seg] || []
    },
    issueColor(i) {
      if (i.status !== 'open') return 'success'
      return { critical: 'danger', high: 'danger', medium: 'warning', low: 'secondary' }[i.severity] || 'warning'
    },
    severityLabel(s) {
      return { critical: '치명', high: '높음', medium: '보통', low: '낮음' }[s] || '보통'
    },
    formatDate(iso) {
      if (!iso) return ''
      return new Date(iso).toLocaleString('ko-KR', { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }
  }
}
</script>

<style>
.ins-body { font-size: 0.8125rem; color: var(--color-ink-muted); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; }
.ins-issue { border-left: 3px solid var(--color-hairline); }
.ins-issue--danger { border-left-color: #c12c39; }
.ins-issue--warning { border-left-color: var(--color-accent-orange); }
.ins-issue--secondary { border-left-color: var(--color-ink-muted); }
.ins-issue--success { border-left-color: #157a29; }
</style>
