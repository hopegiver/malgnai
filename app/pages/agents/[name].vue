<template>
  <div>
    <div class="mb-4">
      <router-link to="/agents" class="text-muted small">&larr; 에이전트 목록</router-link>
    </div>

    <div v-if="agent">
      <div class="d-flex justify-content-between align-items-start mb-4">
        <div>
          <h1 class="mb-1">{{ agent.name }}</h1>
          <p class="text-muted mb-0">{{ agent.job_title || agent.role }}</p>
        </div>
        <div class="d-flex gap-2 flex-wrap justify-content-end">
          <span :class="statusBadge">{{ agent.status === 'active' ? '활성' : '비활성' }}</span>
          <span class="badge bg-light">{{ levelLabel(agent.skill_level) }}</span>
          <span v-if="agent.model" :class="'badge ' + modelBadge(agent.model)"><i class="bi bi-cpu me-1"></i>{{ agent.model }}</span>
          <span :class="'badge ' + learningBadge(agent.learning_status)">{{ learningLabel(agent.learning_status) }}</span>
        </div>
      </div>

      <div class="row g-3 mb-4">
        <div class="col-6 col-md-3">
          <div class="card p-3 text-center">
            <div class="text-eyebrow text-muted mb-1">완료 작업</div>
            <div class="h4 mb-0">{{ agent.total_tasks_completed || 0 }}</div>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <div class="card p-3 text-center">
            <div class="text-eyebrow text-muted mb-1">참여 프로젝트</div>
            <div class="h4 mb-0">{{ agent.total_projects_participated || 0 }}</div>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <div class="card p-3 text-center">
            <div class="text-eyebrow text-muted mb-1">역량 수준</div>
            <div class="h4 mb-0">{{ levelLabel(agent.skill_level) }}</div>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <div class="card p-3 text-center">
            <div class="text-eyebrow text-muted mb-1">마지막 활동</div>
            <div class="small fw-medium">{{ agent.last_active_at ? formatDate(agent.last_active_at) : '-' }}</div>
          </div>
        </div>
      </div>

      <ul class="nav nav-tabs nav-tabs-scroll mb-3">
        <li class="nav-item"><a class="nav-link" :class="{ active: tab === 'overview' }" href="#" @click.prevent="tab='overview'">개요</a></li>
        <li class="nav-item"><a class="nav-link" :class="{ active: tab === 'skills' }" href="#" @click.prevent="tab='skills'">스킬</a></li>
        <li class="nav-item"><a class="nav-link" :class="{ active: tab === 'knowledge' }" href="#" @click.prevent="tab='knowledge'">학습 자료<span v-if="knowledge.length" class="badge bg-secondary ms-1">{{ knowledge.length }}</span></a></li>
        <li class="nav-item"><a class="nav-link" :class="{ active: tab === 'learning' }" href="#" @click.prevent="tab='learning'">학습 이력</a></li>
        <li class="nav-item"><a class="nav-link" :class="{ active: tab === 'activities' }" href="#" @click.prevent="tab='activities'">활동 로그</a></li>
        <li class="nav-item"><a class="nav-link" :class="{ active: tab === 'source' }" href="#" @click.prevent="tab='source'">MD 원문</a></li>
      </ul>

      <div v-if="tab === 'overview'" class="card p-4">
        <h2 class="h6 mb-3">설명</h2>
        <p class="mb-3">{{ agent.description || '설명이 없습니다.' }}</p>
        <hr>
        <h3 class="h6 mb-3"><i class="bi bi-person-badge me-1"></i>AI 직원 카드</h3>
        <div class="row g-3 mb-3">
          <div class="col-md-6">
            <div class="border rounded p-3 h-100">
              <div class="text-eyebrow text-muted mb-2"><i class="bi bi-shield-x text-danger me-1"></i>금지 업무</div>
              <ul v-if="forbiddenTasks.length" class="mb-0 ps-3 small">
                <li v-for="(t, i) in forbiddenTasks" :key="i" class="mb-1">{{ t }}</li>
              </ul>
              <p v-else class="text-muted small mb-0">지정된 금지 업무가 없습니다.</p>
            </div>
          </div>
          <div class="col-md-6">
            <div class="border rounded p-3 h-100">
              <div class="text-eyebrow text-muted mb-2"><i class="bi bi-shield-check text-warning me-1"></i>승인 필요 업무</div>
              <ul v-if="approvalTasks.length" class="mb-0 ps-3 small">
                <li v-for="(t, i) in approvalTasks" :key="i" class="mb-1">{{ t }}</li>
              </ul>
              <p v-else class="text-muted small mb-0">대표 승인 없이 자율 수행 가능한 직무입니다.</p>
            </div>
          </div>
        </div>
        <hr>
        <h3 class="h6 mb-2">기본 정보</h3>
        <table class="table table-sm mb-0">
          <tbody>
            <tr><td class="text-muted table-label-cell">이름</td><td>{{ agent.name }}</td></tr>
            <tr><td class="text-muted table-label-cell">직책</td><td>{{ agent.job_title || agent.role }}</td></tr>
            <tr><td class="text-muted table-label-cell">역할</td><td>{{ agent.role }}</td></tr>
            <tr v-if="agent.model"><td class="text-muted table-label-cell">사용 모델</td><td><span :class="'badge ' + modelBadge(agent.model)">{{ agent.model }}</span></td></tr>
            <tr><td class="text-muted table-label-cell">상태</td><td>{{ agent.status }}</td></tr>
            <tr><td class="text-muted table-label-cell">역량 수준</td><td>{{ levelLabel(agent.skill_level) }}</td></tr>
            <tr><td class="text-muted table-label-cell">학습 상태</td><td>{{ learningLabel(agent.learning_status) }}</td></tr>
            <tr><td class="text-muted table-label-cell">등록일</td><td>{{ formatDate(agent.created_at) }}</td></tr>
            <tr><td class="text-muted table-label-cell">최근 수정</td><td>{{ formatDate(agent.updated_at) }}</td></tr>
            <tr><td class="text-muted table-label-cell">MD 해시</td><td><code class="small">{{ agent.md_hash || '-' }}</code></td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="tab === 'skills'" class="card p-4">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h2 class="h6 mb-0">역할별 필수 스킬</h2>
          <span v-if="skills.length" class="text-muted small">평균 Lv {{ skillAvg }}/5</span>
        </div>

        <div v-if="skills.length">
          <div v-for="(group, cat) in skillsByCategory" :key="cat" class="mb-4">
            <h3 class="text-eyebrow text-muted mb-2">{{ cat }}</h3>
            <div v-for="s in group" :key="s.name" class="border rounded p-3 mb-2">
              <div class="d-flex justify-content-between align-items-center mb-1">
                <span class="fw-medium">{{ s.name }}</span>
                <span :class="'badge bg-' + skillLevelColor(s.level)">Lv {{ s.level }}/{{ s.maxLevel || 5 }}</span>
              </div>
              <p class="text-muted small mb-2">{{ s.description }}</p>

              <div class="progress mb-2" style="height: 6px">
                <div class="progress-bar" :class="'bg-' + skillLevelColor(s.level)" :style="'width:' + (s.level / (s.maxLevel || 5) * 100) + '%'"></div>
              </div>

              <div class="row small">
                <div class="col-md-6">
                  <div class="text-eyebrow text-muted mb-1"><i class="bi bi-book me-1"></i>학습 방법</div>
                  <p class="mb-0 text-ink-secondary">{{ s.how_to_learn }}</p>
                </div>
                <div class="col-md-6">
                  <div class="text-eyebrow text-muted mb-1"><i class="bi bi-link-45deg me-1"></i>학습 리소스</div>
                  <p class="mb-0 text-ink-secondary">{{ s.learning_resources }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <p v-else class="text-muted mb-0">스킬 정의가 없습니다. sync-agents를 실행하세요.</p>
      </div>

      <div v-if="tab === 'knowledge'" class="card p-4">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h2 class="h6 mb-0">학습한 knowledge 자료</h2>
          <span v-if="knowledge.length" class="text-muted small">{{ knowledge.length }}개 문서</span>
        </div>

        <div v-if="knowledge.length">
          <div v-for="(group, folder) in knowledgeByFolder" :key="folder" class="mb-4">
            <h3 class="text-eyebrow text-muted mb-2"><i class="bi bi-folder me-1"></i>{{ folder }}</h3>
            <div class="row g-2">
              <div v-for="k in group" :key="k.folder + '/' + k.file" class="col-md-6">
                <a href="#" @click.prevent="openDoc(k)" class="card h-100 p-3 text-decoration-none text-reset border knowledge-card">
                  <div class="d-flex align-items-start gap-2">
                    <i class="bi bi-file-earmark-text text-primary fs-5"></i>
                    <div class="flex-grow-1 min-w-0">
                      <div class="fw-medium text-truncate">{{ k.title }}</div>
                      <p class="text-muted small mb-1">{{ k.summary || '요약 없음' }}</p>
                      <code class="text-faint" style="font-size: 0.7rem">{{ k.folder }}/{{ k.file }}</code>
                    </div>
                  </div>
                </a>
              </div>
            </div>
          </div>
        </div>
        <p v-else class="text-muted mb-0">연결된 학습 자료가 없습니다. sync-agents를 실행하세요.</p>
      </div>

      <div v-if="tab === 'learning'" class="card p-4">
        <h2 class="h6 mb-3">학습 이력</h2>
        <div v-if="learningLogs.length">
          <div v-for="l in learningLogs" :key="l.id" class="py-2 border-bottom border-hairline">
            <div class="d-flex justify-content-between align-items-center">
              <div>
                <span :class="'badge me-2 bg-' + typeColor(l.type)">{{ typeLabel(l.type) }}</span>
                <span class="fw-medium">{{ l.title }}</span>
              </div>
              <small class="text-faint">{{ formatDate(l.created_at) }}</small>
            </div>
            <p v-if="l.content" class="text-muted small mb-0 mt-1">{{ l.content }}</p>
            <small v-if="l.source" class="text-faint">출처: {{ l.source }}</small>
          </div>
        </div>
        <p v-else class="text-muted mb-0">학습 이력이 없습니다.</p>
      </div>

      <div v-if="tab === 'activities'" class="card">
        <div class="table-responsive">
          <table class="table mb-0">
            <thead><tr><th>시간</th><th>액션</th><th>상세</th></tr></thead>
            <tbody>
              <tr v-for="a in activities" :key="a.id">
                <td><small>{{ formatDate(a.created_at) }}</small></td>
                <td><span class="badge bg-secondary">{{ a.action }}</span></td>
                <td><small class="text-muted">{{ a.detail || '-' }}</small></td>
              </tr>
              <tr v-if="!activities.length"><td colspan="3" class="text-center text-muted py-4">활동 기록이 없습니다.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="tab === 'source'" class="card p-4">
        <h2 class="h6 mb-3">에이전트 MD 원문</h2>
        <pre v-if="agent.md_content" class="bg-canvas-soft p-3 rounded small" style="white-space: pre-wrap; max-height: 600px; overflow-y: auto;">{{ agent.md_content }}</pre>
        <p v-else class="text-muted mb-0">MD 파일이 동기화되지 않았습니다.</p>
      </div>
    </div>

    <div v-else class="text-center py-5 text-muted">에이전트를 불러오는 중...</div>

    <!-- knowledge 문서 모달 -->
    <div v-if="activeDoc" class="modal-overlay" @click.self="activeDoc = null">
      <div class="doc-modal card modal-card">
        <div class="d-flex justify-content-between align-items-center p-3 border-bottom border-hairline">
          <div class="min-w-0">
            <h2 class="h6 mb-0 text-truncate">{{ activeDoc.title }}</h2>
            <code class="text-faint" style="font-size: 0.7rem">{{ activeDoc.folder }}/{{ activeDoc.file }}</code>
          </div>
          <button class="btn-close" @click="activeDoc = null"></button>
        </div>
        <pre class="p-3 mb-0 small" style="white-space: pre-wrap; overflow-y: auto;">{{ activeDoc.content || '내용이 동기화되지 않았습니다.' }}</pre>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: '에이전트 상세',
  data() {
    return {
      agent: null,
      activities: [],
      learningLogs: [],
      tab: 'overview',
      activeDoc: null
    }
  },
  computed: {
    skills() {
      if (!this.agent || !this.agent.skills) return []
      try { return JSON.parse(this.agent.skills) } catch { return [] }
    },
    knowledge() {
      if (!this.agent || !this.agent.knowledge) return []
      try { return JSON.parse(this.agent.knowledge) } catch { return [] }
    },
    knowledgeByFolder() {
      const groups = {}
      for (const k of this.knowledge) {
        const f = k.folder || '기타'
        if (!groups[f]) groups[f] = []
        groups[f].push(k)
      }
      return groups
    },
    skillsByCategory() {
      const groups = {}
      for (const s of this.skills) {
        const cat = s.category || '기타'
        if (!groups[cat]) groups[cat] = []
        groups[cat].push(s)
      }
      return groups
    },
    skillAvg() {
      if (!this.skills.length) return '0'
      return (this.skills.reduce((sum, s) => sum + (s.level || 0), 0) / this.skills.length).toFixed(1)
    },
    forbiddenTasks() {
      if (!this.agent || !this.agent.forbidden_tasks) return []
      try { return JSON.parse(this.agent.forbidden_tasks) } catch { return [] }
    },
    approvalTasks() {
      if (!this.agent || !this.agent.approval_required_tasks) return []
      try { return JSON.parse(this.agent.approval_required_tasks) } catch { return [] }
    },
    statusBadge() {
      return 'badge bg-' + (this.agent && this.agent.status === 'active' ? 'success' : 'secondary')
    }
  },
  async mounted() {
    const name = this.$route.params.name
    const { data, error } = await useApi('/api/agents/' + name)
    if (error) return
    this.agent = data.agent
    this.activities = data.activities || []
    this.learningLogs = data.learning_logs || []
  },
  methods: {
    openDoc(k) {
      this.activeDoc = k
    },
    levelLabel(l) {
      return { beginner: '초급', intermediate: '중급', advanced: '고급', expert: '전문가' }[l] || l
    },
    learningLabel(s) {
      return { idle: '대기', learning: '학습중', reviewing: '리뷰중' }[s] || s || '대기'
    },
    learningBadge(s) {
      return { idle: 'bg-light', learning: 'bg-info', reviewing: 'bg-warning' }[s] || 'bg-light'
    },
    modelBadge(m) {
      return { opus: 'bg-primary', sonnet: 'bg-info', haiku: 'bg-secondary' }[m] || 'bg-light'
    },
    typeLabel(t) {
      return { experience: '경험', external: '외부학습', peer_feedback: '동료피드백', discussion: '토론' }[t] || t
    },
    typeColor(t) {
      return { experience: 'primary', external: 'info', peer_feedback: 'warning', discussion: 'success' }[t] || 'secondary'
    },
    skillLevelColor(level) {
      if (level >= 5) return 'success'
      if (level >= 4) return 'primary'
      if (level >= 3) return 'info'
      if (level >= 2) return 'warning'
      return 'secondary'
    },
    formatDate(iso) {
      if (!iso) return ''
      return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }
  }
}
</script>
