<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-4">
      <h1 class="mb-0">에이전트</h1>
      <span class="badge bg-primary">{{ agents.length }}명</span>
    </div>

    <div v-for="team in teams" :key="team.id" class="mb-4">
      <h2 class="h6 text-muted mb-3">
        <i :class="'bi ' + teamIcon(team) + ' me-1'"></i>
        {{ team.name }}
        <span class="text-faint fw-normal ms-1">{{ team.description }}</span>
      </h2>
      <div class="row g-3">
        <div v-for="a in team.members" :key="a.name" class="col-md-4 col-lg-3">
          <router-link :to="'/agents/' + a.name" class="text-decoration-none">
            <div class="card p-3 h-100">
              <div class="d-flex justify-content-between align-items-center mb-1">
                <h3 class="h6 mb-0 text-ink">{{ a.name }}</h3>
                <span :class="'badge bg-' + levelColor(a.skill_level)">{{ levelLabel(a.skill_level) }}</span>
              </div>
              <div class="d-flex align-items-center gap-1 mb-2">
                <span class="text-faint small text-truncate">{{ a.job_title || a.role }}</span>
                <span v-if="a.model" :class="'badge ms-auto ' + modelBadge(a.model)" style="font-size:0.65rem">{{ a.model }}</span>
              </div>
              <p class="text-muted small mb-2" style="line-height:1.3">{{ a.description ? a.description.substring(0, 60) : a.role }}</p>
              <div class="mt-auto">
                <div class="d-flex justify-content-between align-items-center small">
                  <span class="text-faint">{{ skillCount(a) }} skills</span>
                  <span class="text-faint">Lv {{ skillAvg(a) }}/5</span>
                </div>
                <div class="progress mt-1" style="height: 4px">
                  <div class="progress-bar" :class="'bg-' + levelColor(a.skill_level)" :style="'width:' + (skillAvg(a)/5*100) + '%'"></div>
                </div>
              </div>
            </div>
          </router-link>
        </div>
      </div>
    </div>

    <div v-if="!agents.length" class="text-center text-muted py-4">등록된 에이전트가 없습니다.</div>
  </div>
</template>

<script>
// 팀 화면 메타(라벨·순서·아이콘)만 정의. 어느 팀이 존재하는지는 에이전트 데이터에서 결정한다.
// 여기 없는 팀이 생겨도 팀 ID 그대로 표시되어 절대 누락되지 않는다(맨 뒤 정렬).
const TEAM_META = {
  leadership: { name: "리더십팀", description: "전체 프로젝트 운영과 조율", icon: "bi-star" },
  planning: { name: "기획팀", description: "요구사항 분석, 시장 조사, 전략 기획", icon: "bi-lightbulb" },
  design: { name: "디자인팀", description: "UX/UI 설계와 비주얼 디자인", icon: "bi-palette" },
  development: { name: "개발팀", description: "프론트엔드/백엔드 시스템 구현", icon: "bi-code-slash" },
  quality: { name: "품질팀", description: "테스트, 리뷰, 보안 점검, 배포", icon: "bi-shield-check" },
  communication: { name: "커뮤니케이션팀", description: "문서 작성, 발표 자료 제작", icon: "bi-megaphone" },
  proposal: { name: "제안팀", description: "RFP 분석, 수주 전략, 제안서 작성", icon: "bi-file-earmark-text" },
  marketing: { name: "마케팅팀", description: "마케팅 전략, 캠페인, 채널 운영", icon: "bi-graph-up-arrow" },
  finance: { name: "재무팀", description: "예산, 수익성, 재무 모델링", icon: "bi-cash-coin" },
  training: { name: "교육팀", description: "에이전트 역량 진단, 학습", icon: "bi-mortarboard" },
}
const TEAM_ORDER = Object.keys(TEAM_META)

export default {
  title: '에이전트',
  data() {
    return { agents: [] }
  },
  computed: {
    teams() {
      // 에이전트 목록에서 team 값을 뽑아 그룹핑 → 데이터에 존재하는 팀만 자동 등장
      const byTeam = {}
      for (const a of this.agents) {
        const id = this.getTeam(a)
        ;(byTeam[id] ||= []).push(a)
      }
      return Object.keys(byTeam)
        // 알려진 팀은 정의 순서대로, 모르는 팀은 그 뒤에
        .sort((x, y) => {
          const ix = TEAM_ORDER.indexOf(x), iy = TEAM_ORDER.indexOf(y)
          return (ix === -1 ? 999 : ix) - (iy === -1 ? 999 : iy)
        })
        .map(id => ({
          id,
          name: TEAM_META[id]?.name || id,
          description: TEAM_META[id]?.description || '',
          icon: TEAM_META[id]?.icon || 'bi-people',
          members: byTeam[id],
        }))
    }
  },
  async mounted() {
    const { data, error } = await useApi('/api/agents')
    if (error) return
    this.agents = data.agents || []
  },
  methods: {
    parseSkills(a) {
      if (!a.skills) return []
      try { return JSON.parse(a.skills) } catch { return [] }
    },
    skillCount(a) {
      return this.parseSkills(a).length
    },
    skillAvg(a) {
      const skills = this.parseSkills(a)
      if (!skills.length) return 0
      const avg = skills.reduce((s, sk) => s + (sk.level || 0), 0) / skills.length
      return avg.toFixed(1)
    },
    getTeam(a) {
      // DB의 team 값을 신뢰 (동기화 시 skill-definitions.js의 TEAM_DEFINITIONS 기준으로 채워짐).
      // 값이 없으면 미분류로 모아 누락 없이 노출.
      return a.team || "etc"
    },
    levelLabel(l) {
      return { beginner: '초급', intermediate: '중급', advanced: '고급', expert: '전문가' }[l] || l
    },
    levelColor(l) {
      return { beginner: 'secondary', intermediate: 'info', advanced: 'primary', expert: 'success' }[l] || 'secondary'
    },
    modelBadge(m) {
      return { opus: 'bg-primary', sonnet: 'bg-info', haiku: 'bg-secondary' }[m] || 'bg-light'
    },
    teamIcon(team) {
      return team.icon || 'bi-people'
    }
  }
}
</script>
