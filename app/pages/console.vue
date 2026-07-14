<template>
  <div class="console-page">
    <!-- 상단: 프로젝트 선택 + 새 대화 -->
    <div class="d-flex flex-wrap align-items-center gap-2 mb-3 console-project-bar">
      <h1 class="mb-0 me-2">AI 콘솔</h1>
      <select class="form-select" style="width:auto;max-width:260px" v-model="selectedProjectId" @change="onProjectChange" aria-label="프로젝트 선택">
        <option value="">프로젝트 선택...</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <button class="btn btn-outline-secondary btn-sm" :disabled="!selectedProjectId" @click="startNewSession">
        <i class="bi bi-plus-lg me-1"></i>새 대화
      </button>
      <div class="flex-grow-1"></div>
      <small class="text-muted" v-if="!selectedProjectId">먼저 프로젝트를 선택하세요</small>
    </div>

    <div v-if="!selectedProjectId" class="text-center py-5">
      <i class="bi bi-chat-square-text d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
      <div class="fw-medium mb-1 text-muted">프로젝트를 선택하면 대화를 시작할 수 있습니다</div>
    </div>

    <div v-else class="row g-3 console-body">
      <!-- 좌측: 세션 목록 (데스크톱 카드형 / 모바일 select) -->
      <div class="col-12 col-lg-3 console-session-col">
        <div class="card console-session-list">
          <div class="card-header py-2 fw-semibold small d-flex align-items-center justify-content-between">
            <span><i class="bi bi-clock-history me-1"></i>이전 대화</span>
            <button class="btn btn-sm btn-link p-0" @click="loadSessions" title="새로고침" aria-label="세션 목록 새로고침">
              <i class="bi bi-arrow-clockwise"></i>
            </button>
          </div>
          <div v-if="sessionsLoading" class="p-3">
            <div class="skeleton-line mb-2" style="height:14px;width:90%"></div>
            <div class="skeleton-line mb-2" style="height:14px;width:70%"></div>
            <div class="skeleton-line" style="height:14px;width:80%"></div>
          </div>
          <div v-else-if="sessionsError" class="p-3 small text-danger">{{ sessionsError }}</div>
          <div v-else-if="!displaySessions.length" class="p-3 text-center text-muted small">대화 기록이 없습니다.</div>
          <div v-else class="console-session-items">
            <button
              v-for="s in displaySessions"
              :key="s.session_id"
              type="button"
              class="console-session-item"
              :class="{ active: s.session_id === currentSessionId || s.session_id === '__pending__' || s.session_id === activeTurnId, pending: s.__pending }"
              @click="onSessionClick(s)">
              <div class="d-flex align-items-center justify-content-between gap-1">
                <span class="console-session-title">{{ truncate(s.title, 42) }}</span>
                <span class="console-session-status" :class="'status-' + (s.last_status || 'unknown')" :title="s.last_status"></span>
              </div>
              <div class="d-flex align-items-center justify-content-between mt-1">
                <small class="text-faint">{{ formatDate(s.last_at) }} · {{ s.turn_count }}턴</small>
                <small class="text-faint" v-if="s.total_cost_usd">${{ Number(s.total_cost_usd).toFixed(3) }}</small>
              </div>
            </button>
          </div>
          <div v-if="sessionsHasMore" class="text-center border-top py-2">
            <button type="button" class="btn btn-sm btn-link" :disabled="sessionsLoadingMore" @click="loadMoreSessions">
              <span v-if="sessionsLoadingMore" class="spinner-border spinner-border-sm me-1"></span>더보기
            </button>
          </div>
        </div>

        <!-- 모바일 전용: 이전 대화 select 박스 -->
        <div class="console-session-select-wrap">
          <select
            class="form-select form-select-sm"
            :value="currentSessionId || ''"
            :disabled="sessionsLoading"
            @change="onSessionSelectChange"
            aria-label="이전 대화 선택">
            <option value="">새 대화</option>
            <option v-for="s in displaySessions" :key="s.session_id" :value="s.session_id">
              {{ s.__pending ? '● ' : '' }}{{ truncate(s.title, 42) }} · {{ formatDate(s.last_at) }} · {{ s.turn_count }}턴
            </option>
          </select>
          <div v-if="sessionsError" class="small text-danger mt-1">{{ sessionsError }}</div>
        </div>
      </div>

      <!-- 우측: 채팅 영역 -->
      <div class="col-12 col-lg-9 console-chat-col">
        <div class="card console-chat-card">
          <!-- 대기 배너 -->
          <div v-if="waitingBanner" class="alert alert-warning py-2 px-3 mb-0 rounded-0 small d-flex align-items-center gap-2">
            <span class="spinner-border spinner-border-sm"></span>
            {{ waitingBanner }}
          </div>

          <!-- 메시지 영역 -->
          <div class="console-messages" ref="messagesBox">
            <div v-if="turnsLoading" class="text-center text-muted py-4 small">
              <span class="spinner-border spinner-border-sm me-1"></span>불러오는 중...
            </div>
            <div v-else-if="!turns.length" class="console-empty">
              <i class="bi bi-chat-dots d-block mb-2" style="font-size:2rem;color:var(--color-ink-faint)"></i>
              <div class="text-muted small">메시지를 입력해 대화를 시작하세요.</div>
            </div>
            <template v-else>
              <div v-for="t in turns" :key="t.id" class="console-turn">
                <!-- 사용자 메시지 -->
                <div class="console-msg console-msg--user">
                  <div class="console-bubble console-bubble--user">{{ t.instruction }}</div>
                </div>
                <!-- AI 응답 -->
                <div class="console-msg console-msg--ai">
                  <div class="console-bubble console-bubble--ai">
                    <!-- 진행중 상태 표시 + 강제 종료 버튼 -->
                    <div v-if="isPending(t.status)" class="d-flex align-items-center justify-content-between gap-2 text-muted small mb-2">
                      <div class="d-flex align-items-center gap-2">
                        <span class="spinner-border spinner-border-sm"></span>
                        <span>{{ pendingLabel(t.status) }}</span>
                      </div>
                      <button v-if="t.status === 'running'" class="btn btn-sm btn-outline-danger" @click="terminateCommand(t.id)" :disabled="terminatingId === t.id">
                        <span v-if="terminatingId === t.id" class="spinner-border spinner-border-sm me-1"></span>
                        <i v-else class="bi bi-stop-fill me-1"></i>강제 종료
                      </button>
                    </div>

                    <!-- 실시간 진행 로그 (진행중인 턴에만) -->
                    <div v-if="t.id === activeTurnId && liveLog.length" class="console-live-log">
                      <div v-for="(line, i) in liveLog" :key="i" class="console-log-line" :class="{ 'text-danger': line.isError }">
                        <i class="bi" :class="logIcon(line.kind)"></i>
                        <span class="console-log-text">
                          <strong v-if="line.kind === 'tool_call'">{{ line.tool }}</strong><span v-if="line.kind === 'tool_call' && line.detail"> — {{ line.detail }}</span>
                          <span v-else>{{ line.text || line.detail }}</span>
                        </span>
                      </div>
                    </div>

                    <!-- 최종/완료된 결과 텍스트 -->
                    <div v-if="t.result" class="console-result-text">{{ t.result }}</div>

                    <!-- 에러 -->
                    <div v-if="t.error" class="alert alert-danger py-2 px-2 small mt-2 mb-0">{{ t.error }}</div>

                    <!-- 메타 정보 -->
                    <div v-if="!isPending(t.status)" class="console-turn-meta">
                      <span class="badge" :class="turnStatusBadge(t.status)">{{ turnStatusLabel(t.status) }}</span>
                      <small v-if="t.cost_usd != null" class="text-faint">${{ Number(t.cost_usd).toFixed(4) }}</small>
                      <small class="text-faint">{{ formatDate(t.updated_at || t.created_at) }}</small>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <!-- 입력창 -->
          <div class="console-input-bar">
            <textarea
              ref="inputBox"
              class="form-control console-textarea"
              rows="2"
              v-model="draft"
              :disabled="inputDisabled"
              placeholder="메시지를 입력하세요 (Enter로 전송, Shift+Enter로 줄바꿈)"
              @keydown="onKeydown"></textarea>
            <button class="btn btn-primary console-send-btn" :disabled="inputDisabled || !draft.trim()" @click="sendMessage">
              <span v-if="inputDisabled" class="spinner-border spinner-border-sm"></span>
              <i v-else class="bi bi-send"></i>
            </button>
          </div>
          <div v-if="sendError" class="px-3 pb-2 small text-danger">{{ sendError }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: 'AI 콘솔',
  data() {
    return {
      projects: [],
      selectedProjectId: '',
      sessions: [],
      sessionsLoading: false,
      sessionsLoadingMore: false,
      sessionsHasMore: false,
      sessionsPageSize: 10,
      sessionsError: '',
      currentSessionId: null,
      pendingNewSession: null,
      turns: [],
      turnsLoading: false,
      draft: '',
      inputDisabled: false,
      sendError: '',
      waitingBanner: '',
      activeTurnId: null,
      liveLog: [],
      logCursor: 0,
      pollTimer: null,
      monitorFallback: false,
      terminatingId: null,
    }
  },
  computed: {
    // 신규 세션의 첫 턴이 아직 session_id 를 못 받아 서버 목록(GET /sessions)에 안 잡히는 동안
    // 사이드바에 임시로 보여줄 플레이스홀더를 맨 앞에 얹는다(실행중/대기중 표시용). 서버도 같은
    // 턴을 is_pending 행(session_id=turn id)으로 돌려줄 수 있으니, 내가 보낸 턴과 겹치면 서버쪽
    // 사본은 제외하고 로컬 플레이스홀더(더 실시간)만 남긴다.
    displaySessions() {
      if (!this.pendingNewSession) return this.sessions
      return [this.pendingNewSession, ...this.sessions.filter(s => s.session_id !== this.pendingNewSession.turnId)]
    },
  },
  async mounted() {
    await this.loadProjects()
    // localStorage에서 이전 선택 상태 복구
    const savedProjectId = localStorage.getItem('console_selectedProjectId')
    const savedSessionId = localStorage.getItem('console_currentSessionId')
    if (savedProjectId && this.projects.find(p => p.id === savedProjectId)) {
      this.selectedProjectId = savedProjectId
      await this.onProjectChange()
      if (savedSessionId) {
        const hasSavedSession = this.sessions.find(s => s.session_id === savedSessionId)
        if (hasSavedSession) {
          this.currentSessionId = savedSessionId
          await this.loadTurns()
        }
      }
    }
  },
  unmounted() {
    this.stopPolling()
  },
  methods: {
    // ---------- 초기 로드 ----------
    async loadProjects() {
      const { data, error } = await useApi('/api/projects')
      if (error) return
      this.projects = data.projects || []
      if (this.projects.length === 1) {
        this.selectedProjectId = this.projects[0].id
        await this.onProjectChange()
      }
    },
    async onProjectChange() {
      this.stopPolling()
      this.currentSessionId = null
      this.pendingNewSession = null
      this.turns = []
      this.sendError = ''
      this.waitingBanner = ''
      if (!this.selectedProjectId) {
        localStorage.removeItem('console_selectedProjectId')
        localStorage.removeItem('console_currentSessionId')
        return
      }
      localStorage.setItem('console_selectedProjectId', this.selectedProjectId)
      localStorage.removeItem('console_currentSessionId')
      await this.loadSessions()
    },
    startNewSession() {
      this.stopPolling()
      this.currentSessionId = null
      this.pendingNewSession = null
      this.turns = []
      this.sendError = ''
      this.waitingBanner = ''
      this.inputDisabled = false
      this.draft = ''
      this.activeTurnId = null
      this.liveLog = []
      this.logCursor = 0
      this.monitorFallback = false
      this.$nextTick(() => this.$refs.inputBox?.focus())
    },

    // ---------- 세션 목록 ----------
    async loadSessions() {
      if (!this.selectedProjectId) return
      this.sessionsLoading = true
      this.sessionsError = ''
      const { data, error } = await useApi(`/api/console/sessions?project_id=${this.selectedProjectId}&limit=${this.sessionsPageSize}&offset=0`)
      this.sessionsLoading = false
      if (error) {
        this.sessionsError = typeof error === 'string' ? error : '세션 목록을 불러오지 못했습니다.'
        return
      }
      this.sessions = (data.sessions || []).map(this.normalizeSession)
      this.sessionsHasMore = !!data.has_more
    },
    async loadMoreSessions() {
      if (!this.selectedProjectId || this.sessionsLoadingMore || !this.sessionsHasMore) return
      this.sessionsLoadingMore = true
      const { data, error } = await useApi(`/api/console/sessions?project_id=${this.selectedProjectId}&limit=${this.sessionsPageSize}&offset=${this.sessions.length}`)
      this.sessionsLoadingMore = false
      if (error) return
      this.sessions = [...this.sessions, ...(data.sessions || []).map(this.normalizeSession)]
      this.sessionsHasMore = !!data.has_more
    },
    // 서버가 준 is_pending(진행중 여부)·is_synthetic(session_id 자리에 command.id 가 온 단건 행인지)
    // 를 프론트 표기/라우팅용 __pending·__synthetic 으로 통일.
    normalizeSession(s) {
      return { ...s, __pending: !!s.is_pending, __synthetic: !!s.is_synthetic }
    },
    async selectSession(sessionId) {
      if (!sessionId || sessionId === this.currentSessionId) return
      this.stopPolling()
      this.currentSessionId = sessionId
      this.pendingNewSession = null
      localStorage.setItem('console_currentSessionId', sessionId)
      this.sendError = ''
      this.waitingBanner = ''
      this.activeTurnId = null
      this.liveLog = []
      this.logCursor = 0
      this.monitorFallback = false
      await this.loadTurns()
    },
    // 사이드바 항목 클릭 진입점: 진짜 세션(session_id 로 GROUP BY 된 행)은 selectSession,
    // session_id 미배정 단건 행(synthetic — 진행중이든 이미 종결됐든)은 viewPendingTurn 으로 분기.
    onSessionClick(s) {
      if (s.session_id === '__pending__') return // 내가 방금 보낸 것 — 이미 오른쪽에 보이는 중
      if (s.__synthetic) { this.viewPendingTurn(s.session_id); return }
      this.selectSession(s.session_id)
    },
    // session_id 가 배정되지 않은 단건 턴(synthetic — 진행중 또는 session_id 없이 종결됨)을 조회해
    // 오른쪽 대화창에 띄운다. 아직 진행중이면 폴링에 합류하고, 이미 종결됐으면 resumeTurn 이 곧
    // 종결로 판정해 폴링을 멈춘다(turnId 는 findConsoleSessions 의 synthetic 행에서 session_id
    // 자리에 온 command.id).
    async viewPendingTurn(turnId) {
      if (turnId === this.activeTurnId) return
      this.stopPolling()
      this.currentSessionId = null
      this.pendingNewSession = null
      localStorage.removeItem('console_currentSessionId')
      this.sendError = ''
      this.waitingBanner = ''
      this.turnsLoading = true
      const { data, error } = await useApi(`/api/console/turns/${turnId}?project_id=${this.selectedProjectId}`)
      this.turnsLoading = false
      if (error || !data.turn) {
        this.sendError = typeof error === 'string' ? error : '대화 내용을 불러오지 못했습니다.'
        return
      }
      this.turns = [data.turn]
      this.scrollToBottom()
      this.activeTurnId = data.turn.id
      this.inputDisabled = true
      this.resumeTurn(data.turn)
    },
    // 모바일 세션 select 박스 전용: 빈 값이면 새 대화, 아니면 onSessionClick 재사용
    onSessionSelectChange(e) {
      const val = e.target.value
      if (!val) {
        this.startNewSession()
        return
      }
      const target = this.displaySessions.find(s => s.session_id === val)
      if (target) this.onSessionClick(target)
    },
    async loadTurns() {
      if (!this.currentSessionId) return
      this.turnsLoading = true
      const { data, error } = await useApi(`/api/console/sessions/${this.currentSessionId}/turns?project_id=${this.selectedProjectId}`)
      this.turnsLoading = false
      if (error) {
        this.sendError = typeof error === 'string' ? error : '대화 내용을 불러오지 못했습니다.'
        return
      }
      this.turns = data.turns || []
      this.scrollToBottom()

      // 마지막 턴이 진행 중이면 상태기계에 재편입 (새로고침 복구)
      const last = this.turns[this.turns.length - 1]
      if (last && this.isPending(last.status)) {
        this.activeTurnId = last.id
        this.inputDisabled = true
        this.resumeTurn(last)
      } else {
        this.inputDisabled = false
      }
    },

    // ---------- 턴 전송 ----------
    isPending(status) {
      return ['approved', 'claimed', 'running'].includes(status)
    },
    pendingLabel(status) {
      if (status === 'approved') return '대기 중...'
      if (status === 'claimed') return '작업 준비 중...'
      return '생각 중...'
    },
    onKeydown(e) {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.sendMessage()
      }
    },
    async sendMessage() {
      const message = this.draft.trim()
      if (!message || this.inputDisabled) return
      if (!this.selectedProjectId) return

      this.sendError = ''
      this.inputDisabled = true
      this.draft = ''

      // 낙관적 렌더용 임시 턴
      const tempId = 'temp-' + Date.now()
      const optimisticTurn = {
        id: tempId,
        instruction: message,
        result: '',
        status: 'approved',
        error: null,
        cost_usd: null,
        session_id: this.currentSessionId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      this.turns = [...this.turns, optimisticTurn]
      this.scrollToBottom()

      const { data, error } = await useApi('/api/console/turns', {
        method: 'POST',
        body: {
          project_id: this.selectedProjectId,
          message,
          session_id: this.currentSessionId || null,
          idempotency_key: crypto.randomUUID(),
        },
      })

      if (error) {
        this.sendError = typeof error === 'string' ? error : '메시지 전송에 실패했습니다.'
        this.turns = this.turns.filter(t => t.id !== tempId)
        this.pendingNewSession = null
        this.inputDisabled = false
        this.draft = message
        return
      }

      const command = data.command || {}
      // 임시 턴을 실제 command 정보로 교체
      const realTurn = {
        ...optimisticTurn,
        id: command.id,
        status: command.status || 'approved',
        session_id: command.session_id || this.currentSessionId,
      }
      this.turns = this.turns.map(t => (t.id === tempId ? realTurn : t))
      this.activeTurnId = command.id

      // 신규 세션의 첫 턴 — session_id 가 아직 없어 서버 세션 목록에 안 잡히는 동안
      // 사이드바에 보여줄 임시 플레이스홀더(완료되면 finishTurn 에서 정리됨).
      this.pendingNewSession = realTurn.session_id ? null : {
        session_id: '__pending__',
        turnId: command.id,
        __pending: true,
        title: message,
        last_status: realTurn.status,
        last_at: realTurn.created_at,
        turn_count: 1,
        total_cost_usd: null,
      }
      this.liveLog = []
      this.logCursor = 0
      this.monitorFallback = false

      if (command.status === 'approved') {
        this.waitingBanner = '이 프로젝트에서 다른 작업이 진행 중입니다 — 대기 중'
      } else {
        this.waitingBanner = ''
      }

      this.startPolling(realTurn)
    },

    // ---------- 폴링 상태기계 ----------
    resumeTurn(turn) {
      this.activeTurnId = turn.id
      this.liveLog = []
      this.logCursor = 0
      this.monitorFallback = false
      if (turn.status === 'approved') {
        this.waitingBanner = '이 프로젝트에서 다른 작업이 진행 중입니다 — 대기 중'
      }
      this.startPolling(turn)
    },
    // approved(미claim)일 땐 2초 간격으로 턴 상태만, claimed/running일 땐 1초 간격으로
    // 모니터 로그를 폴링한다 — setInterval 고정 주기 대신 재귀 setTimeout으로 매 틱마다
    // 다음 지연시간을 상태에 맞게 다시 정한다(요청 중첩 방지 + 가변 주기 동시 충족).
    startPolling(turn) {
      this.stopPolling()
      this.schedulePoll(turn.id, 0)
    },
    schedulePoll(turnId, delay) {
      this.pollTimer = setTimeout(async () => {
        const nextDelay = await this.pollTick(turnId)
        if (nextDelay != null) this.schedulePoll(turnId, nextDelay)
      }, delay)
    },
    stopPolling() {
      if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    },
    // 반환값: 다음 폴링까지 대기할 ms, 또는 null(턴 종결 — 더 이상 폴링하지 않음)
    async pollTick(turnId) {
      const turn = this.turns.find(t => t.id === turnId)
      if (!turn) return null

      if (turn.status === 'approved') {
        // 아직 claim 안됨 — 턴 상태만 2초 간격으로 확인
        const { data, error } = await useApi(`/api/console/turns/${turnId}?project_id=${this.selectedProjectId}`)
        if (error) return 2000
        this.applyTurnUpdate(turnId, data.turn)
        if (data.turn && data.turn.status !== 'approved') {
          this.waitingBanner = ''
        }
        if (data.turn && !this.isPending(data.turn.status)) {
          this.finishTurn(turnId, data.turn)
          return null
        }
        return 2000
      }

      if (this.monitorFallback) {
        // 모니터 GC/재시작 폴백: 턴 상태만 계속 확인
        const { data, error } = await useApi(`/api/console/turns/${turnId}?project_id=${this.selectedProjectId}`)
        if (error) return 1000
        this.applyTurnUpdate(turnId, data.turn)
        if (data.turn && !this.isPending(data.turn.status)) {
          this.finishTurn(turnId, data.turn)
          return null
        }
        return 1000
      }

      // claimed/running: 1초 간격 실시간 로그 폴링
      const token = localStorage.getItem('token')
      const tq = token ? `&token=${encodeURIComponent(token)}` : ''
      const logRes = await useApi(`/api/monitor/log/${turnId}?since=${this.logCursor}${tq}`)

      if (logRes.error) {
        // 404 등 → 폴백 모드
        this.monitorFallback = true
        return 1000
      }

      const { entries, total, status } = logRes.data
      this.logCursor = total || this.logCursor
      for (const entry of (entries || [])) {
        this.pushLiveLog(entry)
      }

      if (status === 'done') {
        const { data, error } = await useApi(`/api/console/turns/${turnId}?project_id=${this.selectedProjectId}`)
        if (error) return 1000
        this.applyTurnUpdate(turnId, data.turn)
        if (data.turn && !this.isPending(data.turn.status)) {
          this.finishTurn(turnId, data.turn)
          return null
        }
        return 1000
      } else {
        // 진행 중 상태 갱신(claimed → running 등)
        this.turns = this.turns.map(t => (t.id === turnId ? { ...t, status: 'running' } : t))
        this.syncSidebarStatus(turn.session_id, 'running')
        return 1000
      }
    },
    // 진행 중인 턴의 상태 변화를 사이드바(기존 세션 점 색 / 신규세션 플레이스홀더)에도 실시간 반영.
    syncSidebarStatus(sessionId, status) {
      if (sessionId) {
        const idx = this.sessions.findIndex(s => s.session_id === sessionId)
        if (idx >= 0 && this.sessions[idx].last_status !== status) {
          this.sessions = this.sessions.map((s, i) => (i === idx ? { ...s, last_status: status } : s))
        }
      } else if (this.pendingNewSession) {
        this.pendingNewSession = { ...this.pendingNewSession, last_status: status }
      }
    },
    pushLiveLog(entry) {
      if (entry.kind === 'stderr') {
        this.liveLog = [...this.liveLog, { kind: 'stderr', text: entry.text, isError: true }].slice(-150)
      } else {
        const replace = !!(entry.streaming && entry.blockId != null)
        if (replace && this.liveLog.length) {
          this.liveLog.splice(this.liveLog.length - 1, 1, entry)
        } else {
          this.liveLog = [...this.liveLog, entry].slice(-150)
        }
      }
      this.scrollToBottom()
    },
    applyTurnUpdate(turnId, turnData) {
      if (!turnData) return
      this.turns = this.turns.map(t => (t.id === turnId ? { ...t, ...turnData } : t))
      this.syncSidebarStatus(turnData.session_id, turnData.status)
    },
    finishTurn(turnId, finalTurn) {
      this.stopPolling()
      this.waitingBanner = ''
      this.liveLog = []
      this.activeTurnId = null
      this.inputDisabled = false
      this.pendingNewSession = null
      if (finalTurn && finalTurn.session_id && !this.currentSessionId) {
        this.currentSessionId = finalTurn.session_id
        this.loadSessions()
      }
      this.$nextTick(() => this.$refs.inputBox?.focus())
      this.scrollToBottom()
    },

    // ---------- 헬퍼 ----------
    logIcon(kind) {
      if (kind === 'tool_call') return 'bi-lightning-charge text-warning'
      if (kind === 'tool_result') return 'bi-arrow-return-right text-info'
      if (kind === 'stderr') return 'bi-terminal text-muted'
      return 'bi-chat-left-text text-muted'
    },
    turnStatusLabel(status) {
      const M = { done: '완료', failed: '실패', rejected: '거부됨', queued: '승인 대기' }
      return M[status] || status
    },
    turnStatusBadge(status) {
      const M = { done: 'bg-success', failed: 'bg-danger', rejected: 'bg-danger', queued: 'bg-warning text-dark' }
      return M[status] || 'bg-secondary'
    },
    truncate(str, len) {
      if (!str) return '(제목 없음)'
      return str.length > len ? str.slice(0, len) + '...' : str
    },
    formatDate(iso) {
      if (!iso) return ''
      return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    },
    scrollToBottom() {
      this.$nextTick(() => {
        const box = this.$refs.messagesBox
        if (box) box.scrollTop = box.scrollHeight
      })
    },
    async terminateCommand(commandId) {
      this.terminatingId = commandId
      try {
        const { data, error } = await useApi(`/api/commands/${commandId}/terminate`, {
          method: 'PATCH',
        })
        if (error) {
          alert('강제 종료 실패: ' + (typeof error === 'string' ? error : '알 수 없는 오류'))
          return
        }
        const terminated = data.command
        const turnIdx = this.turns.findIndex(t => t.id === commandId)
        if (turnIdx >= 0) {
          this.turns[turnIdx] = terminated
        }
        await this.loadTurns()
      } finally {
        this.terminatingId = null
      }
    },
  }
}
</script>

<style>
.console-body { min-height: 0; }

.console-session-list {
  max-height: 640px;
  display: flex;
  flex-direction: column;
}
.console-session-items {
  overflow-y: auto;
}
.console-session-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
}
.console-session-item:hover {
  background: var(--color-surface-hover);
}
.console-session-item.active {
  background: var(--color-primary-soft, var(--color-brand-soft));
  border-left: 3px solid var(--color-primary);
}
.console-session-title {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-ink);
}
.console-session-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-ink-faint);
}
.console-session-status.status-done { background: var(--color-success); }
.console-session-status.status-failed,
.console-session-status.status-rejected { background: var(--color-danger); }
.console-session-status.status-running,
.console-session-status.status-claimed,
.console-session-status.status-approved { background: var(--color-warning); }

/* 모바일 전용 세션 select — 데스크톱에서는 숨김(카드형 목록 사용) */
.console-session-select-wrap { display: none; }

.console-chat-card {
  display: flex;
  flex-direction: column;
  height: 640px;
  overflow: hidden;
}
.console-messages {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 16px;
}
.console-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.console-turn {
  margin-bottom: 20px;
}
.console-msg {
  display: flex;
  margin-bottom: 8px;
}
.console-msg--user { justify-content: flex-end; }
.console-msg--ai { justify-content: flex-start; }

.console-bubble {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.5;
}
.console-bubble--user {
  background: var(--color-primary, var(--color-brand));
  color: #fff;
  border-bottom-right-radius: 4px;
}
.console-bubble--ai {
  background: var(--color-surface-hover);
  color: var(--color-ink);
  border-bottom-left-radius: 4px;
  width: 100%;
}

.console-result-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.console-live-log {
  background: #111;
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 8px;
  max-height: 240px;
  overflow-y: auto;
}
.console-log-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  font-family: var(--font-monospace, monospace);
  color: #e5e7eb;
  margin-bottom: 4px;
}
.console-log-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.console-turn-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.console-input-bar {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--color-border);
}
.console-textarea {
  resize: none;
}
.console-send-btn {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 991.98px) {
  /* 페이지 전체를 헤더/본문패딩/하단 탭바를 제외한 뷰포트 높이에 정확히 맞춰
     스크롤은 .console-messages 안에서만 발생하게 한다.
     - 헤더: var(--header-h) (base.css .admin-header)
     - main 상단 패딩: p-3 = 16px (app/layouts/default.vue)
     - main 하단 패딩: 60px + safe-area (base.css .admin-main 모바일 하단 탭바 여백, 991.98px 이하)
     100dvh 를 우선 쓰되, 미지원 브라우저 대비 100vh 를 먼저 선언해 폴백시킨다. */
  .console-page {
    height: calc(100vh - var(--header-h) - 16px - 60px - env(safe-area-inset-bottom, 0px));
    height: calc(100dvh - var(--header-h) - 16px - 60px - env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .console-project-bar { flex-shrink: 0; }

  .console-body {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    flex-wrap: nowrap;
    min-height: 0;
  }
  .console-session-col { flex-shrink: 0 !important; }
  .console-chat-col { flex: 1 1 auto !important; min-height: 0; }

  /* 이전 대화: 카드형 목록 대신 select 박스로 전환 */
  .console-session-list { display: none; }
  .console-session-select-wrap { display: block; }

  .console-chat-card { height: 100%; }
}
</style>
