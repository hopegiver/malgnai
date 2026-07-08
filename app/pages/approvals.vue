<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h1 class="mb-0">승인 대기함</h1>
      <span v-if="pendingCount > 0" class="badge bg-danger">{{ pendingCount }}건 대기</span>
    </div>

    <!-- 요약 바 — 위험도별 카운트를 한눈에(고위험 건이 묻히지 않도록). counts 는 risk 필터와 무관한
         별도 무필터 조회(loadCounts)라서 어떤 탭이 켜져 있어도 항상 정확하다 -->
    <div v-if="pendingCount > 0" class="d-flex flex-wrap align-items-center gap-3 mb-3 small text-muted">
      <span class="fw-medium text-body">대기 중 {{ pendingCount }}건</span>
      <span>높음 <span class="fw-semibold" :class="riskCount('high') > 0 ? 'text-danger' : ''">{{ riskCount('high') }}</span></span>
      <span>보통 <span class="fw-semibold" :class="riskCount('medium') > 0 ? 'text-warning-emphasis' : ''">{{ riskCount('medium') }}</span></span>
      <span>낮음 <span class="fw-semibold">{{ riskCount('low') }}</span></span>
    </div>

    <!-- 위험도 필터 탭 — 대기 건이 있을 때만(0건이면 empty state 하나로, 제로 중복 제거) -->
    <div v-if="pendingCount > 0" class="btn-group btn-group-sm mb-3">
      <button v-for="f in filters" :key="f.value" type="button"
              class="btn" :class="risk === f.value ? 'btn-primary' : 'btn-outline-secondary'"
              @click="setRisk(f.value)">
        {{ f.label }}
        <span v-if="f.value !== 'all'" class="ms-1">{{ riskCount(f.value) }}</span>
      </button>
    </div>

    <!-- 일시 안내(409 등) — alert 대신 인라인 배너 -->
    <div v-if="toast" class="alert alert-info py-2 d-flex justify-content-between align-items-center" role="status">
      <span><i class="bi bi-info-circle me-2"></i>{{ toast }}</span>
      <button type="button" class="btn-close" aria-label="닫기" @click="toast = ''"></button>
    </div>

    <!-- API 에러 — 화면에 노출(console.error로 삼키지 않음) -->
    <div v-if="error" class="alert alert-danger d-flex justify-content-between align-items-center" role="alert">
      <span><i class="bi bi-exclamation-triangle me-2"></i>{{ error }}</span>
      <button type="button" class="btn btn-sm btn-outline-danger" @click="load">다시 시도</button>
    </div>

    <div v-if="loading" class="text-muted py-4">불러오는 중…</div>
    <div v-else-if="!visibleCards.length" class="text-center text-muted py-5">
      <i class="bi bi-inbox d-block mb-2" style="font-size: 2rem;"></i>
      대기 중인 승인 항목이 없습니다.
    </div>

    <div v-for="c in visibleCards" :key="c.id" class="card p-3 mb-3 border-start border-4"
         :class="[riskBorder(c.risk_level), { 'opacity-75': c._reviewed }]">
      <div class="d-flex justify-content-between align-items-start mb-2">
        <div class="me-2">
          <!-- 어느 프로젝트인지 먼저 — 프로젝트명 뱃지 + 작업유형 태그 -->
          <div class="mb-1">
            <span class="badge bg-primary-subtle text-primary-emphasis">
              <i class="bi bi-folder me-1"></i>{{ c.project_name || '프로젝트 미상' }}
            </span>
            <span class="badge bg-secondary-subtle text-secondary-emphasis ms-1">{{ taskTypeLabel(c.task_type) }}</span>
          </div>
          <!-- 실제 무슨 일인지 — title 을 주인공으로(옛 business/customer 대체) -->
          <div class="fw-bold">{{ c.title || c.ai_summary || firstLine(c.instruction) || '(제목 없음)' }}</div>
        </div>
        <span :class="'badge bg-' + riskColor(c.risk_level)">위험도 {{ riskLabel(c.risk_level) }}</span>
      </div>

      <p v-if="c.ai_summary && c.ai_summary !== c.title" class="mb-2">{{ c.ai_summary }}</p>

      <!-- 상세보기: 실제 실행될 명령 전체 내용(그동안 화면에 아예 안 나오던 핵심 정보) -->
      <details v-if="c.instruction" class="mb-2">
        <summary class="small text-muted" style="cursor: pointer;">명령 상세 보기</summary>
        <pre class="small mb-0 mt-1 p-2 rounded bg-canvas-soft" style="white-space: pre-wrap;">{{ c.instruction }}</pre>
      </details>

      <details v-if="c.evidence" class="mb-2">
        <summary class="small text-muted" style="cursor: pointer;">근거 데이터 보기</summary>
        <pre class="small mb-0 mt-1 p-2 rounded bg-canvas-soft" style="white-space: pre-wrap;">{{ c.evidence }}</pre>
      </details>

      <div v-if="c.recommended_action" class="alert alert-light py-2 small mb-2">
        <i class="bi bi-lightbulb me-1"></i>추천: {{ c.recommended_action }}
      </div>

      <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div class="d-flex align-items-center flex-wrap gap-2">
          <span class="text-faint small">${{ (c.cost_usd || 0).toFixed(2) }} · {{ fmt(c.created_at) }}</span>
          <router-link v-if="c.project_id" :to="'/projects/' + c.project_id" class="small text-decoration-none text-muted ms-1">
            프로젝트 보기 →
          </router-link>
        </div>

        <!-- 미처리: 액션 버튼 / 처리됨: 상태 뱃지 -->
        <div v-if="!c._reviewed" class="btn-group btn-group-sm">
          <button type="button" class="btn btn-success" :disabled="c._busy" @click="review(c, 'approve')">승인</button>
          <button type="button" class="btn btn-warning" :disabled="c._busy" @click="review(c, 'request_changes')">수정 요청</button>
          <button type="button" class="btn btn-outline-danger" :disabled="c._busy" @click="review(c, 'reject')">반려</button>
        </div>
        <div v-else class="d-flex align-items-center gap-2">
          <span :class="'badge bg-' + decisionColor(c._reviewStatus)">
            <i :class="'bi ' + decisionIcon(c._reviewStatus) + ' me-1'"></i>{{ decisionLabel(c._reviewStatus) }}
          </span>
          <button type="button" class="btn btn-sm btn-link text-muted p-0" @click="undo(c)">되돌리기</button>
        </div>
      </div>

      <div v-if="c._reviewed && c._reviewNote" class="small text-muted mt-2">
        <i class="bi bi-chat-left-text me-1"></i>사유: {{ c._reviewNote }}
      </div>
    </div>

    <!-- 처리완료 아코디언 -->
    <details v-if="processedCards.length" class="mt-4">
      <summary class="small text-muted" style="cursor:pointer">
        <i class="bi bi-check2-circle me-1"></i>오늘 처리한 건 {{ processedCards.length }}건 보기
      </summary>
      <div class="mt-2">
        <div v-for="c in processedCards" :key="'done-' + c.id" class="card p-3 mb-2 border-start border-4 opacity-75"
             :class="riskBorder(c.risk_level)">
          <div class="d-flex justify-content-between align-items-start mb-2">
            <div class="me-2">
              <div class="mb-1">
                <span class="badge bg-primary-subtle text-primary-emphasis">
                  <i class="bi bi-folder me-1"></i>{{ c.project_name || '프로젝트 미상' }}
                </span>
                <span class="badge bg-secondary-subtle text-secondary-emphasis ms-1">{{ taskTypeLabel(c.task_type) }}</span>
              </div>
              <div class="fw-bold">{{ c.title || c.ai_summary || firstLine(c.instruction) || '(제목 없음)' }}</div>
            </div>
            <span :class="'badge bg-' + decisionColor(c._reviewStatus)">
              <i :class="'bi ' + decisionIcon(c._reviewStatus) + ' me-1'"></i>{{ decisionLabel(c._reviewStatus) }}
            </span>
          </div>
          <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div class="d-flex align-items-center flex-wrap gap-2">
              <span class="text-faint small">${{ (c.cost_usd || 0).toFixed(2) }} · {{ fmt(c.created_at) }}</span>
              <router-link v-if="c.project_id" :to="'/projects/' + c.project_id" class="small text-decoration-none text-muted ms-1">
                프로젝트 보기 →
              </router-link>
            </div>
            <button type="button" class="btn btn-sm btn-link text-muted p-0" @click="undo(c)">되돌리기</button>
          </div>
          <div v-if="c._reviewNote" class="small text-muted mt-2">
            <i class="bi bi-chat-left-text me-1"></i>사유: {{ c._reviewNote }}
          </div>
        </div>
      </div>
    </details>

    <!-- 수정요청/반려 사유 입력 모달 (window.prompt 대체 — 소형 모달) -->
    <div v-if="reviewModal.open" class="modal-backdrop-custom" @click.self="closeReviewModal">
      <div class="card p-4" style="max-width:440px;width:100%" role="dialog" aria-modal="true" :aria-labelledby="'review-modal-title'">
        <h5 id="review-modal-title" class="mb-3">{{ reviewModal.title }}</h5>
        <textarea v-model="reviewModal.note" class="form-control mb-3" rows="4"
                  :placeholder="reviewModal.placeholder" @keydown.meta.enter="submitReviewModal"></textarea>
        <div class="d-flex justify-content-end gap-2">
          <button type="button" class="btn btn-outline-secondary" @click="closeReviewModal">취소</button>
          <button type="button" class="btn btn-primary" @click="submitReviewModal">{{ reviewModal.confirmLabel }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
// (d) mock → 실제 전환 경로: true=mock(서버 호출 없음), false=실제 API.
// 실데이터 전환 완료: 기본은 실 API. mock 분기는 플래그로 보존(회귀/오프라인 점검용).
const USE_MOCK = false

export default {
  title: '승인 대기함',
  data() {
    return {
      cards: [],
      loading: false,
      error: '',       // API 에러 메시지(화면 노출 — console.error로 삼키지 않음)
      toast: '',        // 일시 안내(409 등). alert 대신 인라인 배너.
      toastTimer: null,
      risk: 'all',      // load() 최초 응답 후 riskDefaulted 로 1회 '높음' 우선 자동 전환
      riskDefaulted: false,
      counts: { high: 0, medium: 0, low: 0 },   // risk 필터와 무관한 전체 대기 건수(별도 무필터 조회) — 필터 중에도 정확한 배지/요약 표시용
      reviewModal: { open: false, command: null, decision: null, note: '', title: '', placeholder: '', confirmLabel: '확인' },
      filters: [
        { value: 'all', label: '전체' },
        { value: 'high', label: '높음' },
        { value: 'medium', label: '보통' },
        { value: 'low', label: '낮음' },
      ],
    }
  },
  computed: {
    processedCards() {
      return this.cards.filter(c => c._reviewed)
    },
    pendingCards() {
      return this.cards.filter(c => !c._reviewed)
    },
    // 표시 목록. 실데이터는 서버가 이미 risk로 필터하므로 그대로 노출.
    // mock은 서버 호출이 없으므로 클라이언트에서 risk 필터를 적용.
    visibleCards() {
      if (USE_MOCK && this.risk !== 'all') {
        return this.pendingCards.filter(c => (c.risk_level || 'low') === this.risk)
      }
      return this.pendingCards
    },
    // 미처리(대기) 전체 건수 — risk 필터와 무관(counts 합계). 필터 중에도 헤더 배지가 줄어들지 않게.
    pendingCount() {
      if (USE_MOCK) return this.pendingCards.length
      return this.counts.high + this.counts.medium + this.counts.low
    },
  },
  async mounted() {
    await this.loadCounts()   // load()의 위험도 기본필터 자동전환이 counts 를 참조하므로 먼저 완료
    await this.load()
  },
  methods: {
    // risk 필터와 무관한 전체 대기 건수 조회(요약바·필터탭 배지·헤더 배지용). cards 와 별도 상태.
    async loadCounts() {
      if (USE_MOCK) return
      const { data, error } = await useApi('/api/commands?inbox=pending&limit=200')
      if (error) return
      const list = data.commands || []
      this.counts = {
        high: list.filter(c => (c.risk_level || 'low') === 'high').length,
        medium: list.filter(c => (c.risk_level || 'low') === 'medium').length,
        low: list.filter(c => (c.risk_level || 'low') === 'low').length,
      }
    },
    async load() {
      this.loading = true
      this.error = ''
      if (USE_MOCK) {
        this.cards = this.mockCards()
        this.loading = false
        return
      }
      // 실데이터 경로. 서버에서 risk_level 필터(inbox=pending → status='queued' AND review_status IS NULL).
      const q = this.risk === 'all' ? '' : `&risk_level=${this.risk}`
      const { data, error } = await useApi(`/api/commands?inbox=pending${q}`)
      this.loading = false
      if (error) {
        // 에러를 삼키지 않고 화면에 노출(frontend-dev 원칙).
        this.error = `목록을 불러오지 못했습니다: ${error}`
        this.cards = []
        return
      }
      this.cards = data.commands || []
      // 최초 로드 1회만: 고위험 건이 묻히지 않도록 '높음' 탭을 기본 선택(0건이면 '보통'으로 폴백, 그마저 0건이면 '전체' 유지).
      if (!this.riskDefaulted && this.risk === 'all') {
        this.riskDefaulted = true
        if (this.counts.high > 0) { this.risk = 'high'; return this.load() }
        if (this.counts.medium > 0) { this.risk = 'medium'; return this.load() }
      }
    },
    setRisk(v) {
      this.risk = v
      // 실데이터는 서버 필터(this.load 재호출). mock일 때만 클라이언트 필터(visibleCards)로 즉시 반영.
      if (!USE_MOCK) this.load()
    },
    // 사유 입력이 필요한 결정(반려·수정요청·세션이어받기 승인)은 모달을 띄우고, 즉시 확정 가능한
    //   일반 승인은 바로 실행한다. window.prompt/confirm 은 쓰지 않는다(브라우저 네이티브 UI 지양).
    review(c, decision) {
      if (decision === 'reject' || decision === 'request_changes') {
        this.openReviewModal(c, decision, {
          title: decision === 'reject' ? '반려 사유' : '수정 요청 내용',
          placeholder: '사유를 입력하세요...',
          confirmLabel: decision === 'reject' ? '반려하기' : '수정 요청 보내기',
        })
        return
      }
      if (decision === 'approve' && c.task_type === 'resume' && c.session_id) {
        // (§9) resume command 승인 = 세션 이어받기. 대표 답변이 review_note 로 실려 워커가
        //   claude --resume <sid> -p "<답변>" 로 흘려보낸다. 비우면 "이어서 진행" 기본 신호.
        this.openReviewModal(c, decision, {
          title: '세션에 이어서 전달할 답변',
          placeholder: '비워두면 그냥 진행됩니다',
          confirmLabel: '이어서 진행',
        })
        return
      }
      this.doReview(c, decision, '')
    },
    openReviewModal(c, decision, { title, placeholder, confirmLabel }) {
      this.reviewModal = { open: true, command: c, decision, note: '', title, placeholder, confirmLabel }
    },
    closeReviewModal() {
      this.reviewModal = { open: false, command: null, decision: null, note: '', title: '', placeholder: '', confirmLabel: '확인' }
    },
    submitReviewModal() {
      const { command, decision, note } = this.reviewModal
      this.closeReviewModal()
      this.doReview(command, decision, note)
    },
    async doReview(c, decision, note) {
      if (USE_MOCK) {
        // mock: 목록에서 제거하지 않고 "처리됨" 상태로 토글(눈으로 확인 가능).
        c._reviewed = true
        c._reviewStatus = this.toReviewStatus(decision)
        c._reviewNote = note
        return
      }
      // 실데이터 경로: 서버에 review 반영.
      c._busy = true
      const { error } = await useApi(`/api/commands/${c.id}/review`, {
        method: 'PATCH',
        body: { decision, review_note: note },
      })
      c._busy = false
      if (error) {
        // 409 = 이미 다른 곳에서 처리됨(TOCTOU). useApi가 본문 error 문자열을 그대로 반환.
        // 서버 메시지는 영문이므로 사용자에겐 안내 문구로 치환하고 목록을 새로고침.
        const isConflict = /already reviewed|terminal state/i.test(error)
        if (isConflict) {
          this.showToast('이미 처리된 항목입니다. 목록을 새로고침합니다.')
        } else {
          this.showToast(`처리에 실패했습니다: ${error}`)
        }
        await this.load() // 서버 최신 상태로 동기화(처리된 건은 inbox=pending에서 빠짐)
        await this.loadCounts()
        return
      }
      // 성공: pendingCards 에서는 빠지고 processedCards(처리완료 아코디언)로 이동 + 요약 카운트 갱신.
      //   (즉시 사라지면 "처리됐는지 불명확" 문제 재발 → 카드는 유지하고 상태만 전환)
      c._reviewed = true
      c._reviewStatus = this.toReviewStatus(decision)
      c._reviewNote = note
      this.showToast(this.decisionLabel(this.toReviewStatus(decision)) + '으로 처리했습니다.')
      await this.loadCounts()
    },
    // 인라인 토스트(배너). alert/confirm 지양 — 기존 디자인 톤 유지. 4초 후 자동 소거.
    showToast(msg) {
      this.toast = msg
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toastTimer = setTimeout(() => { this.toast = '' }, 4000)
    },
    // mock 전용: 처리 상태 되돌리기
    undo(c) {
      c._reviewed = false
      c._reviewStatus = null
      c._reviewNote = ''
    },
    // decision → review_status 매핑(설계 (b) 전이 매핑과 일치)
    toReviewStatus(decision) {
      return { approve: 'approved', reject: 'rejected', request_changes: 'changes_requested' }[decision] || decision
    },
    riskColor(r) {
      return { high: 'danger', medium: 'warning', low: 'secondary' }[r] || 'secondary'
    },
    // 위험도별 좌측 보더 색 — 고위험 카드를 시각적으로 먼저 띄운다.
    riskBorder(r) {
      return { high: 'border-danger', medium: 'border-warning', low: 'border-light' }[r] || 'border-light'
    },
    riskLabel(r) {
      return { high: '높음', medium: '보통', low: '낮음' }[r] || r || '낮음'
    },
    riskCount(level) {
      if (USE_MOCK) return this.cards.filter(c => (c.risk_level || 'low') === level).length
      return this.counts[level] || 0
    },
    taskTypeLabel(t) {
      return {
        // 현행(자율 프로젝트 운영) 작업 유형
        project_cycle: '자율 사이클',
        resume: '세션 이어받기',
        'git-commit-push': '커밋·푸시',
        server_check: '서버 점검',
        dev_pr: '개발 PR',
        // 레거시(옛 비전) — 데이터 남아있으면 그대로 표기
        customer_reply: '고객 답변',
        proposal: '제안서/메일',
        conversion: '전환 후보 분석',
      }[t] || (t ? t : '작업')
    },
    // instruction 첫 비어있지 않은 줄 — title 도 summary 도 없을 때의 최후 폴백.
    firstLine(s) {
      if (!s) return ''
      const line = String(s).split('\n').map(x => x.trim()).find(Boolean) || ''
      return line.length > 80 ? line.slice(0, 80) + '…' : line
    },
    decisionColor(s) {
      return { approved: 'success', rejected: 'danger', changes_requested: 'warning' }[s] || 'secondary'
    },
    decisionLabel(s) {
      return { approved: '승인됨', rejected: '반려됨', changes_requested: '수정 요청됨' }[s] || s
    },
    decisionIcon(s) {
      return { approved: 'bi-check-circle', rejected: 'bi-x-circle', changes_requested: 'bi-pencil' }[s] || 'bi-dot'
    },
    fmt(s) {
      return s ? new Date(s).toLocaleString('ko-KR') : ''
    },
    // mock 데이터 — 필드명은 설계 문서(9.2)와 100% 일치. 위험도 high/medium/low 골고루.
    mockCards() {
      const now = Date.now()
      const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString()
      return [
        {
          id: 'm1', project_id: 'lms', status: 'queued',
          task_type: 'customer_reply', business: 'LMS', customer: '○○기업',
          risk_level: 'high',
          ai_summary: '장애 클레임에 대한 보상 답변 초안. 환불 언급 포함 → 승인 필요.',
          evidence: '티켓 #3021\n장애 시간 2h\nSLA 99.9% 위반 (월 누적 다운타임 초과)',
          recommended_action: '답변 발송 승인 또는 보상범위 수정',
          review_status: null, cost_usd: 0.12, created_at: iso(8),
        },
        {
          id: 'm2', project_id: 'lms', status: 'queued',
          task_type: 'dev_pr', business: 'LMS', customer: null,
          risk_level: 'medium',
          ai_summary: '관리자 목록 페이징 버그 수정 PR. 단위 테스트 통과.',
          evidence: 'PR #88 · 3 files changed · test green (24/24)',
          recommended_action: 'PR 머지 승인',
          review_status: null, cost_usd: 0.34, created_at: iso(22),
        },
        {
          id: 'm3', project_id: 'crm', status: 'queued',
          task_type: 'conversion', business: 'CRM', customer: '△△커머스',
          risk_level: 'low',
          ai_summary: '최근 30일 무료체험 사용자 중 전환 가능성 상위 12명 추출. 후속 메일 미발송.',
          evidence: '체험 사용자 248명 · 활성도 상위 12명 (로그인 7회+ / 핵심기능 3종 사용)',
          recommended_action: '전환 제안 메일 발송 검토',
          review_status: null, cost_usd: 0.05, created_at: iso(45),
        },
        {
          id: 'm4', project_id: 'infra', status: 'queued',
          task_type: 'server_check', business: '공통 인프라', customer: null,
          risk_level: 'high',
          ai_summary: '프로덕션 DB 디스크 사용률 89% 도달. 자동 정리 스크립트 실행 제안(되돌릴 수 없는 로그 삭제 포함).',
          evidence: 'disk: 89% (445GB/500GB)\n증가 추세: +1.8%/day\n예상 임계 도달: 6일 후',
          recommended_action: '오래된 audit 로그 90일+ 삭제 승인 또는 디스크 증설',
          review_status: null, cost_usd: 0.02, created_at: iso(70),
        },
        {
          id: 'm5', project_id: 'sales', status: 'queued',
          task_type: 'proposal', business: '영업', customer: '◇◇그룹',
          risk_level: 'medium',
          ai_summary: '연간 계약 갱신 제안서 초안. 단가 7% 인상안 포함.',
          evidence: '기존 계약: 12개월 · 전년 사용량 +18%\n경쟁사 제안 정황 있음',
          recommended_action: '제안서 검토 후 영업 담당에게 전달',
          review_status: null, cost_usd: 0.21, created_at: iso(120),
        },
      ]
    },
  },
}
</script>
