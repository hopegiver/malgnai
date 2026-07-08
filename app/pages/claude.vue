<template>
  <div>
    <h1 class="mb-3">Claude Code</h1>

    <div class="alert alert-light border py-2 px-3 small mb-4 d-flex align-items-center">
      <i class="bi bi-diagram-3 me-2 text-muted"></i>
      각 대화 세션은 매칭되는 프로젝트의 <strong class="mx-1">진행상황 &rsaquo; 통합 타임라인</strong>에도 함께 표시됩니다.
    </div>

    <!-- Summary Cards -->
    <div class="row g-3 mb-4">
      <div class="col-6 col-lg-3">
        <div class="card p-3 text-center">
          <div class="text-muted small">누적 사용량 <span class="text-faint">(API 종량 환산)</span></div>
          <div class="fs-4 fw-bold" style="color: var(--color-accent-green)">${{ (summary.total_cost_usd || 0).toFixed(2) }}</div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="card p-3 text-center">
          <div class="text-muted small">총 토큰</div>
          <div class="fs-4 fw-bold">{{ formatTokens(summary.total_tokens) }}</div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="card p-3 text-center">
          <div class="text-muted small">최근 7일 메시지</div>
          <div class="fs-4 fw-bold">{{ (summary.recent_7days?.messages || 0).toLocaleString() }}</div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="card p-3 text-center">
          <div class="text-muted small">대화 기록</div>
          <div class="fs-4 fw-bold">{{ summary.history_count }}</div>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <ul class="nav nav-tabs mb-3">
      <li class="nav-item">
        <a class="nav-link" :class="{ active: tab === 'stats' }" href="#" @click.prevent="tab = 'stats'">
          <i class="bi bi-graph-up me-1"></i>일별 통계
        </a>
      </li>
      <li class="nav-item">
        <a class="nav-link" :class="{ active: tab === 'tokens' }" href="#" @click.prevent="tab = 'tokens'">
          <i class="bi bi-coin me-1"></i>토큰 사용량
        </a>
      </li>
      <li class="nav-item">
        <a class="nav-link" :class="{ active: tab === 'usage' }" href="#" @click.prevent="tab = 'usage'">
          <i class="bi bi-search me-1"></i>토큰 도둑
        </a>
      </li>
      <li class="nav-item">
        <a class="nav-link" :class="{ active: tab === 'memories' }" href="#" @click.prevent="tab = 'memories'">
          <i class="bi bi-brain me-1"></i>메모리
        </a>
      </li>
      <li class="nav-item">
        <a class="nav-link" :class="{ active: tab === 'history' }" href="#" @click.prevent="tab = 'history'">
          <i class="bi bi-chat-dots me-1"></i>대화 기록
        </a>
      </li>
      <li class="nav-item">
        <a class="nav-link" :class="{ active: tab === 'projects' }" href="#" @click.prevent="tab = 'projects'">
          <i class="bi bi-folder me-1"></i>프로젝트별 작업
        </a>
      </li>
      <li class="nav-item">
        <a class="nav-link" :class="{ active: tab === 'sessions' }" href="#" @click.prevent="tab = 'sessions'">
          <i class="bi bi-terminal me-1"></i>세션
        </a>
      </li>
      <li class="nav-item">
        <a class="nav-link d-flex align-items-center gap-1" :class="{ active: tab === 'monitor' }" href="#" @click.prevent="tab = 'monitor'">
          <span v-if="monitorActive.length" class="rounded-circle bg-success" style="width:8px;height:8px;flex-shrink:0;animation:pulse 1.5s infinite;"></span>
          <i v-else class="bi bi-activity me-1"></i>
          실행 모니터<span v-if="monitorActive.length" class="badge bg-success ms-1">{{ monitorActive.length }}</span>
        </a>
      </li>
    </ul>

    <!-- Stats Tab -->
    <div v-if="tab === 'stats'">
      <div class="card">
        <!-- Chart Area -->
        <div class="p-3 border-bottom" style="height: 200px; position: relative; overflow-x: auto;" ref="statsChartBox">
          <div class="d-flex align-items-end gap-1" style="height: 100%; width: max-content; min-width: 100%;">
            <div v-for="s in statsChart" :key="s.date" class="d-flex flex-column align-items-center" style="flex: 0 0 32px;">
              <small class="text-muted" style="font-size: 0.625rem;">{{ s.message_count }}</small>
              <div :style="{ height: s.barHeight + 'px', width: '100%', maxWidth: '24px', backgroundColor: 'var(--color-primary)', borderRadius: '3px 3px 0 0', minHeight: '2px' }"></div>
              <small class="text-muted" style="font-size: 0.5625rem; white-space: nowrap;">{{ s.label }}</small>
            </div>
          </div>
        </div>
        <div class="table-responsive">
          <table class="table mb-0">
            <thead>
              <tr>
                <th>날짜</th>
                <th class="text-end">메시지</th>
                <th class="text-end">세션</th>
                <th class="text-end">도구 호출</th>
                <th class="text-end">프로젝트</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in stats" :key="s.date">
                <td>{{ s.date }}</td>
                <td class="text-end">{{ s.message_count?.toLocaleString() }}</td>
                <td class="text-end">{{ s.session_count }}</td>
                <td class="text-end">{{ s.tool_call_count?.toLocaleString() }}</td>
                <td class="text-end">{{ s.project_count }}</td>
              </tr>
              <tr v-if="!stats.length">
                <td colspan="5" class="text-center text-muted py-4">통계 데이터가 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Tokens Tab -->
    <div v-if="tab === 'tokens'">
      <!-- 일별 토큰 차트 -->
      <div class="card mb-3">
        <div class="p-3 border-bottom fw-bold small">일별 토큰 사용량</div>
        <div class="p-3 border-bottom" style="height: 200px; position: relative; overflow-x: auto;" ref="tokensChartBox">
          <div class="d-flex align-items-end gap-1" style="height: 100%; width: max-content; min-width: 100%;">
            <div v-for="t in tokensChart" :key="t.date" class="d-flex flex-column align-items-center" style="flex: 0 0 32px;">
              <small class="text-muted" style="font-size: 0.5625rem;">{{ formatTokens(t.total) }}</small>
              <div :style="{ height: t.barHeight + 'px', width: '100%', maxWidth: '24px', backgroundColor: 'var(--color-primary)', borderRadius: '3px 3px 0 0', minHeight: '2px' }"></div>
              <small class="text-muted" style="font-size: 0.5625rem; white-space: nowrap;">{{ t.label }}</small>
            </div>
          </div>
        </div>
        <div class="table-responsive">
          <table class="table mb-0">
            <thead>
              <tr>
                <th>날짜</th>
                <th class="text-end">총 토큰</th>
                <th>모델별</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in tokenDaily" :key="t.date">
                <td>{{ t.date }}</td>
                <td class="text-end">{{ t.total?.toLocaleString() }}</td>
                <td>
                  <small v-for="(v, m) in t.by_model" :key="m" class="text-muted d-inline-block me-2">
                    {{ m }}: {{ v.toLocaleString() }}
                  </small>
                </td>
              </tr>
              <tr v-if="!tokenDaily.length">
                <td colspan="3" class="text-center text-muted py-4">토큰 데이터가 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 모델별 누적 사용량 -->
      <div class="card">
        <div class="p-3 border-bottom fw-bold small">모델별 누적 사용량</div>
        <div class="table-responsive">
          <table class="table mb-0">
            <thead>
              <tr>
                <th>모델</th>
                <th class="text-end">입력</th>
                <th class="text-end">출력</th>
                <th class="text-end">캐시 읽기</th>
                <th class="text-end">캐시 생성</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in modelUsage" :key="u.model">
                <td><span class="badge bg-info">{{ u.model }}</span></td>
                <td class="text-end">{{ u.input_tokens?.toLocaleString() }}</td>
                <td class="text-end">{{ u.output_tokens?.toLocaleString() }}</td>
                <td class="text-end text-muted">{{ u.cache_read_tokens?.toLocaleString() }}</td>
                <td class="text-end text-muted">{{ u.cache_creation_tokens?.toLocaleString() }}</td>
              </tr>
              <tr v-if="!modelUsage.length">
                <td colspan="5" class="text-center text-muted py-4">모델 사용량 데이터가 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Usage (토큰 도둑) Tab -->
    <div v-if="tab === 'usage'">
      <!-- 기간 필터 -->
      <div class="mb-3 d-flex gap-2 flex-wrap align-items-center">
        <span class="small text-muted">기간:</span>
        <button v-for="opt in [['today','오늘'],['week','최근 7일'],['','전체']]" :key="opt[0]"
          class="btn btn-sm" :class="usageSince === opt[0] ? 'btn-primary' : 'btn-outline-secondary'"
          @click="usageSince = opt[0]; loadUsage()">{{ opt[1] }}</button>
      </div>

      <!-- 요약 카드 -->
      <div class="row g-3 mb-3" v-if="usageSummary">
        <div class="col-6 col-lg-3">
          <div class="card p-3 text-center"><div class="text-muted small">세션</div>
            <div class="fs-5 fw-bold">{{ (usageSummary.sessions || 0).toLocaleString() }}</div></div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="card p-3 text-center"><div class="text-muted small">총 토큰</div>
            <div class="fs-5 fw-bold">{{ formatTokens(usageSummary.tokens) }}</div></div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="card p-3 text-center"><div class="text-muted small">추정 비용</div>
            <div class="fs-5 fw-bold" style="color: var(--color-accent-green)">${{ (usageSummary.cost_usd || 0).toFixed(2) }}</div></div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="card p-3 text-center"><div class="text-muted small">서브에이전트 비중</div>
            <div class="fs-5 fw-bold">{{ usagePct(usageSummary.sub_tokens, usageSummary.tokens) }}%</div></div>
        </div>
      </div>
      <div class="small text-muted mb-3" v-if="usageSummary">
        캐시읽기 {{ formatTokens(usageSummary.cache_read) }} ({{ usagePct(usageSummary.cache_read, usageSummary.tokens) }}%, 저렴) ·
        캐시쓰기 1h {{ formatTokens(usageSummary.cache_write_1h) }} (2배 요금) ·
        메인 {{ usagePct(usageSummary.main_tokens, usageSummary.tokens) }}% / 서브 {{ usagePct(usageSummary.sub_tokens, usageSummary.tokens) }}%
      </div>

      <div class="row g-3">
        <!-- 세션 Top -->
        <div class="col-lg-7">
          <div class="card">
            <div class="p-3 border-bottom fw-bold small">세션 Top (비용순)</div>
            <div class="table-responsive">
              <table class="table table-sm mb-0 small">
                <thead><tr><th>세션 / 제목</th><th class="text-end">메인턴</th><th class="text-end">서브턴</th><th class="text-end">서브</th><th class="text-end">토큰</th><th class="text-end">비용</th></tr></thead>
                <tbody>
                  <tr v-for="s in usageSessions" :key="s.session_id">
                    <td><div class="fw-semibold">{{ truncate(s.title, 34) }}</div>
                      <div class="text-faint" style="font-size:.75rem">{{ s.session_id.slice(0,8) }} · {{ formatProjectKey(s.project_key) }}</div></td>
                    <td class="text-end">{{ s.main_turns }}</td>
                    <td class="text-end">{{ s.sub_turns || 0 }}</td>
                    <td class="text-end">{{ s.sub_agent_count || 0 }}</td>
                    <td class="text-end">{{ formatTokens(s.total_tokens) }}</td>
                    <td class="text-end fw-bold">${{ (s.cost_usd || 0).toFixed(2) }}</td>
                  </tr>
                  <tr v-if="!usageSessions.length"><td colspan="6" class="text-center text-muted p-3">데이터 없음</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <!-- 에이전트 type별 + 프로젝트별 -->
        <div class="col-lg-5">
          <div class="card mb-3">
            <div class="p-3 border-bottom fw-bold small">서브에이전트 type별 (도둑)</div>
            <div class="table-responsive">
              <table class="table table-sm mb-0 small">
                <thead><tr><th>에이전트</th><th class="text-end">호출</th><th class="text-end">최대턴</th><th class="text-end">토큰</th><th class="text-end">비용</th></tr></thead>
                <tbody>
                  <tr v-for="a in usageAgents" :key="a.agent_type">
                    <td class="fw-semibold">{{ a.agent_type }}</td>
                    <td class="text-end">{{ a.invocations }}</td>
                    <td class="text-end">{{ a.max_turns }}</td>
                    <td class="text-end">{{ formatTokens(a.tokens) }}</td>
                    <td class="text-end fw-bold">${{ (a.cost_usd || 0).toFixed(2) }}</td>
                  </tr>
                  <tr v-if="!usageAgents.length"><td colspan="5" class="text-center text-muted p-3">데이터 없음</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="card">
            <div class="p-3 border-bottom fw-bold small">프로젝트별</div>
            <div class="table-responsive">
              <table class="table table-sm mb-0 small">
                <thead><tr><th>프로젝트</th><th class="text-end">세션</th><th class="text-end">토큰</th><th class="text-end">비용</th></tr></thead>
                <tbody>
                  <tr v-for="p in usageProjects" :key="p.project_key">
                    <td>{{ truncate(formatProjectKey(p.project_key), 24) }}</td>
                    <td class="text-end">{{ p.sessions }}</td>
                    <td class="text-end">{{ formatTokens(p.tokens) }}</td>
                    <td class="text-end fw-bold">${{ (p.cost_usd || 0).toFixed(2) }}</td>
                  </tr>
                  <tr v-if="!usageProjects.length"><td colspan="4" class="text-center text-muted p-3">데이터 없음</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Memories Tab -->
    <div v-if="tab === 'memories'">
      <!-- Project Filter -->
      <div class="mb-3 d-flex gap-2 flex-wrap">
        <button class="btn btn-sm" :class="memoryProject === '' ? 'btn-primary' : 'btn-outline-secondary'" @click="memoryProject = ''; loadMemories()">
          전체
        </button>
        <button v-for="p in memoryProjects" :key="p.project_key" class="btn btn-sm"
          :class="memoryProject === p.project_key ? 'btn-primary' : 'btn-outline-secondary'"
          @click="memoryProject = p.project_key; loadMemories()">
          {{ formatProjectKey(p.project_key) }}
          <span class="badge bg-secondary ms-1">{{ p.memory_count }}</span>
        </button>
      </div>

      <div class="row g-3">
        <div v-for="m in memories" :key="m.id" class="col-12 col-md-6">
          <div class="card p-3">
            <div class="d-flex align-items-start gap-2 mb-2">
              <span class="badge" :class="memoryTypeBadge(m.type)">{{ m.type || 'unknown' }}</span>
              <strong class="flex-grow-1">{{ m.name }}</strong>
            </div>
            <p v-if="m.description" class="text-muted small mb-2">{{ m.description }}</p>
            <div class="small bg-light rounded p-2" style="white-space: pre-wrap; max-height: 200px; overflow-y: auto;">{{ m.content }}</div>
            <div class="d-flex justify-content-between mt-2">
              <small class="text-muted">{{ formatProjectKey(m.project_key) }}</small>
              <small class="text-muted">{{ m.file_name }}</small>
            </div>
          </div>
        </div>
        <div v-if="!memories.length" class="col-12">
          <div class="card p-4 text-center text-muted">메모리 데이터가 없습니다.</div>
        </div>
      </div>
    </div>

    <!-- History Tab -->
    <div v-if="tab === 'history'">
      <div class="card">
        <div class="table-responsive">
          <table class="table mb-0">
            <thead>
              <tr>
                <th>시간</th>
                <th>프로젝트</th>
                <th>내용</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in history" :key="h.id">
                <td style="white-space: nowrap;"><small>{{ formatDate(h.created_at) }}</small></td>
                <td><span class="badge bg-secondary">{{ formatProjectKey(h.project || '-') }}</span></td>
                <td><small>{{ truncate(h.display, 120) }}</small></td>
              </tr>
              <tr v-if="!history.length">
                <td colspan="3" class="text-center text-muted py-4">대화 기록이 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Project Sessions Tab: 프로젝트별 AI 작업 이력(트랜스크립트 집계) -->
    <div v-if="tab === 'projects'">
      <!-- 프로젝트별 집계 -->
      <div class="card mb-3">
        <div class="p-3 border-bottom fw-bold small">프로젝트별 AI 투입 (세션/메시지/도구)</div>
        <div class="table-responsive">
          <table class="table mb-0">
            <thead>
              <tr>
                <th>프로젝트</th>
                <th class="text-end">세션</th>
                <th class="text-end">메시지</th>
                <th class="text-end">도구 호출</th>
                <th>최근 작업</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in projectAgg" :key="a.project_key" style="cursor:pointer" @click="filterProject(a.project_key)" :class="{ 'table-active': sessionFilter === a.project_key }">
                <td>{{ formatProjectKey(a.project_key) }}</td>
                <td class="text-end fw-medium">{{ a.session_count }}</td>
                <td class="text-end text-muted">{{ (a.message_count || 0).toLocaleString() }}</td>
                <td class="text-end text-muted">{{ (a.tool_count || 0).toLocaleString() }}</td>
                <td><small class="text-faint">{{ formatDate(a.last_started_at) }}</small></td>
              </tr>
              <tr v-if="!projectAgg.length">
                <td colspan="5" class="text-center text-muted py-4">집계 데이터가 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 세션 목록 (선택 프로젝트 필터) -->
      <div class="card">
        <div class="p-3 border-bottom d-flex justify-content-between align-items-center">
          <span class="fw-bold small">작업 세션 {{ sessionFilter ? '— ' + formatProjectKey(sessionFilter) : '(전체)' }}</span>
          <button v-if="sessionFilter" class="btn btn-sm btn-outline-secondary" @click="filterProject('')">전체 보기</button>
        </div>
        <div class="table-responsive">
          <table class="table mb-0">
            <thead>
              <tr>
                <th>시작</th>
                <th>프로젝트</th>
                <th>작업 제목</th>
                <th>브랜치</th>
                <th class="text-end">메시지</th>
                <th class="text-end">도구</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in projectSessions" :key="s.id">
                <td style="white-space: nowrap;"><small>{{ formatDate(s.started_at) }}</small></td>
                <td><span class="badge bg-secondary">{{ formatProjectKey(s.project_key) }}</span></td>
                <td><small>{{ s.title || '(제목 없음)' }}</small></td>
                <td><small class="text-muted font-monospace">{{ s.git_branch || '-' }}</small></td>
                <td class="text-end"><small>{{ s.message_count }}</small></td>
                <td class="text-end"><small>{{ s.tool_count }}</small></td>
              </tr>
              <tr v-if="!projectSessions.length">
                <td colspan="6" class="text-center text-muted py-4">세션 데이터가 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Monitor Tab -->
    <div v-if="tab === 'monitor'">

      <!-- Active Runs -->
      <div class="card mb-3">
        <div class="card-header d-flex align-items-center justify-content-between py-2">
          <span class="fw-semibold">
            <i class="bi bi-lightning-charge me-1 text-warning"></i>실행 중
            <span class="badge bg-success ms-1">{{ monitorActive.length }}</span>
          </span>
          <small class="text-muted">{{ monitorSse ? '연결됨' : '연결 끊김' }}</small>
        </div>
        <div v-if="!monitorActive.length" class="text-center text-muted py-4 small">
          <i class="bi bi-pause-circle me-1"></i>현재 실행 중인 AI 작업이 없습니다.
        </div>
        <div v-for="run in monitorActive" :key="run.id" class="p-3 border-bottom">
          <div class="d-flex align-items-start justify-content-between gap-2">
            <div style="min-width:0;">
              <div class="d-flex align-items-center gap-2 mb-1">
                <span class="badge" :class="run.taskType === 'project_cycle' ? 'bg-info' : 'bg-primary'">{{ run.taskType === 'project_cycle' ? 'AI 자율' : '직접 명령' }}</span>
                <strong>{{ run.projectName }}</strong>
              </div>
              <div class="text-muted small" style="word-break:break-word;">{{ run.instruction.slice(0, 150) }}{{ run.instruction.length > 150 ? '…' : '' }}</div>
            </div>
            <div class="text-end flex-shrink-0">
              <div class="fw-bold text-warning font-monospace" style="font-size:1.1rem;">{{ formatElapsed(run.startedAt) }}</div>
              <small class="text-muted">경과</small>
            </div>
          </div>
        </div>
      </div>

      <!-- 진행 로그 (stream-json 요약: AI 응답·도구 호출·도구 결과) -->
      <div v-if="monitorLog.length" class="card mb-3">
        <div class="card-header d-flex align-items-center justify-content-between py-2">
          <span class="fw-semibold"><i class="bi bi-terminal me-1"></i>진행 로그</span>
          <button class="btn btn-sm btn-outline-secondary py-0 px-2" @click="monitorLog = []">지우기</button>
        </div>
        <div class="p-2" style="max-height:280px;overflow-y:auto;background:#111;border-radius:0 0 8px 8px;" ref="logBox">
          <div v-for="(line, i) in monitorLog" :key="i" class="d-flex align-items-start gap-2 mb-1" style="font-size:0.75rem;">
            <i class="bi" :class="monitorLogIcon(line.kind)"></i>
            <span v-if="line.projectName" class="badge bg-secondary" style="font-size:0.65rem;">{{ line.projectName }}</span>
            <span class="font-monospace" :class="line.isError ? 'text-danger' : 'text-light'" style="white-space:pre-wrap;word-break:break-word;">
              <strong v-if="line.kind === 'tool_call'">{{ line.tool }}</strong><span v-if="line.kind === 'tool_call' && line.detail"> — {{ line.detail }}</span>
              <span v-else>{{ line.text || line.detail }}</span>
            </span>
          </div>
        </div>
      </div>

      <!-- Recent Completions -->
      <div class="card">
        <div class="card-header py-2 fw-semibold">
          <i class="bi bi-check2-circle me-1 text-success"></i>최근 완료
        </div>
        <div v-if="!monitorRecent.length" class="text-center text-muted py-4 small">완료된 작업이 없습니다.</div>
        <div v-else class="table-responsive">
          <table class="table table-sm mb-0">
            <thead>
              <tr>
                <th>상태</th>
                <th>프로젝트</th>
                <th>종류</th>
                <th>명령</th>
                <th class="text-end">소요</th>
                <th class="text-end">비용</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in monitorRecent" :key="run.id + run.endedAt">
                <td>
                  <span class="badge" :class="run.status === 'done' ? 'bg-success' : 'bg-danger'">{{ run.status === 'done' ? '완료' : '실패' }}</span>
                </td>
                <td>{{ run.projectName }}</td>
                <td><small class="text-muted">{{ run.taskType === 'project_cycle' ? 'AI 자율' : '직접' }}</small></td>
                <td><small class="text-muted">{{ run.instruction.slice(0, 60) }}{{ run.instruction.length > 60 ? '…' : '' }}</small></td>
                <td class="text-end"><small>{{ formatDuration(run.durationMs) }}</small></td>
                <td class="text-end"><small>{{ run.costUsd != null ? '$' + run.costUsd.toFixed(4) : '-' }}</small></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Sessions Tab -->
    <div v-if="tab === 'sessions'">
      <div class="card">
        <div class="table-responsive">
          <table class="table mb-0">
            <thead>
              <tr>
                <th>시작 시간</th>
                <th>PID</th>
                <th>작업 디렉토리</th>
                <th>종류</th>
                <th>진입점</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in sessions" :key="s.id">
                <td style="white-space: nowrap;"><small>{{ formatDate(s.started_at) }}</small></td>
                <td>{{ s.pid }}</td>
                <td><small class="text-muted">{{ s.cwd }}</small></td>
                <td><span class="badge bg-info">{{ s.kind }}</span></td>
                <td><small>{{ s.entrypoint }}</small></td>
              </tr>
              <tr v-if="!sessions.length">
                <td colspan="5" class="text-center text-muted py-4">세션 데이터가 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: 'Claude Code',
  data() {
    return {
      tab: 'stats',
      summary: {},
      stats: [],
      tokenDaily: [],
      modelUsage: [],
      memories: [],
      memoryProjects: [],
      memoryProject: '',
      history: [],
      sessions: [],
      projectAgg: [],
      projectSessions: [],
      sessionFilter: '',
      usageSince: 'today',
      usageSummary: null,
      usageSessions: [],
      usageAgents: [],
      usageProjects: [],
      monitorActive: [],
      monitorRecent: [],
      monitorLog: [],
      monitorSse: null,
      monitorTick: 0,
      monitorTimer: null,
    }
  },
  unmounted() {
    this.disconnectMonitor()
  },
  computed: {
    statsChart() {
      const items = this.stats.slice(0, 30).reverse()
      const max = Math.max(...items.map(s => s.message_count || 0), 1)
      return items.map(s => ({
        ...s,
        barHeight: Math.round(((s.message_count || 0) / max) * 140),
        label: s.date?.slice(5) || '',
      }))
    },
    tokensChart() {
      const items = this.tokenDaily.slice(0, 30).reverse()
      const max = Math.max(...items.map(t => t.total || 0), 1)
      return items.map(t => ({
        ...t,
        barHeight: Math.round(((t.total || 0) / max) * 140),
        label: t.date?.slice(5) || '',
      }))
    }
  },
  async mounted() {
    await this.loadSummary()
    await this.loadTab()
  },
  watch: {
    async tab(newVal, oldVal) {
      if (oldVal === 'monitor') this.disconnectMonitor()
      await this.loadTab()
    }
  },
  methods: {
    async loadSummary() {
      const { data } = await useApi('/api/claude/summary')
      if (data) this.summary = data.summary || {}
    },
    async loadTab() {
      if (this.tab === 'stats') await this.loadStats()
      else if (this.tab === 'tokens') await this.loadTokens()
      else if (this.tab === 'memories') { await this.loadMemoryProjects(); await this.loadMemories() }
      else if (this.tab === 'history') await this.loadHistory()
      else if (this.tab === 'sessions') await this.loadSessions()
      else if (this.tab === 'projects') { await this.loadProjectAgg(); await this.loadProjectSessions() }
      else if (this.tab === 'usage') await this.loadUsage()
      else if (this.tab === 'monitor') this.connectMonitor()
    },
    connectMonitor() {
      if (this.monitorSse) return
      const token = localStorage.getItem('token')
      const url = token ? `/api/monitor/stream?token=${encodeURIComponent(token)}` : '/api/monitor/stream'
      const es = new EventSource(url)
      es.onmessage = (e) => {
        let data
        try { data = JSON.parse(e.data) } catch { return }
        if (data.type === 'init') {
          this.monitorActive = data.active || []
          this.monitorRecent = data.recent || []
          // 탭을 늦게 열었을 때 이미 쌓인 진행 로그를 재주입(backlog replay).
          for (const run of (data.active || [])) {
            for (const item of (run.events || [])) {
              this.pushMonitorLog({ ...item, projectName: run.projectName }, false)
            }
          }
        } else if (data.type === 'start') {
          this.monitorActive = [...this.monitorActive.filter(r => r.id !== data.run.id), data.run]
        } else if (data.type === 'end') {
          this.monitorActive = this.monitorActive.filter(r => r.id !== data.run.id)
          this.monitorRecent = [data.run, ...this.monitorRecent].slice(0, 20)
        } else if (data.type === 'progress') {
          this.pushMonitorLog({ ...data.item, projectName: data.projectName }, data.replace)
        } else if (data.type === 'chunk') {
          this.pushMonitorLog({ kind: 'stderr', text: data.text, ts: Date.now(), projectName: data.projectName }, false)
        }
      }
      this.monitorSse = es
      if (!this.monitorTimer) {
        this.monitorTimer = setInterval(() => { this.monitorTick++ }, 1000)
      }
    },
    disconnectMonitor() {
      if (this.monitorSse) { this.monitorSse.close(); this.monitorSse = null }
      if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null }
    },
    pushMonitorLog(entry, replace) {
      if (replace && this.monitorLog.length) {
        this.monitorLog.splice(this.monitorLog.length - 1, 1, entry)
      } else {
        this.monitorLog = [...this.monitorLog, entry].slice(-150)
      }
      this.$nextTick(() => {
        const box = this.$refs.logBox
        if (box) box.scrollTop = box.scrollHeight
      })
    },
    monitorLogIcon(kind) {
      if (kind === 'tool_call') return 'bi-lightning-charge text-warning'
      if (kind === 'tool_result') return 'bi-arrow-return-right text-info'
      if (kind === 'stderr') return 'bi-terminal text-muted'
      return 'bi-chat-left-text text-light'
    },
    formatElapsed(startedAt) {
      void this.monitorTick  // 1초마다 재렌더 트리거
      const s = Math.floor((Date.now() - startedAt) / 1000)
      const m = Math.floor(s / 60)
      const h = Math.floor(m / 60)
      if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      return `${m}:${String(s % 60).padStart(2, '0')}`
    },
    formatDuration(ms) {
      if (!ms) return '-'
      const s = Math.round(ms / 1000)
      if (s < 60) return `${s}s`
      const m = Math.floor(s / 60)
      return `${m}m ${s % 60}s`
    },
    async loadUsage() {
      const q = this.usageSince ? `?since=${this.usageSince}` : ''
      const [sum, ses, ag, pr] = await Promise.all([
        useApi('/api/claude/usage/summary' + q),
        useApi('/api/claude/usage/sessions' + (q ? q + '&limit=20' : '?limit=20')),
        useApi('/api/claude/usage/agents' + q),
        useApi('/api/claude/usage/projects' + q),
      ])
      this.usageSummary = sum.data?.summary || null
      this.usageSessions = ses.data?.sessions || []
      this.usageAgents = ag.data?.agents || []
      this.usageProjects = pr.data?.projects || []
    },
    usagePct(part, total) {
      if (!total) return 0
      return Math.round((part || 0) / total * 100)
    },
    async loadProjectAgg() {
      const { data } = await useApi('/api/claude/project-sessions/aggregates')
      if (data) this.projectAgg = data.aggregates || []
    },
    async loadProjectSessions() {
      const q = this.sessionFilter ? `?project_key=${this.sessionFilter}&limit=100` : '?limit=50'
      const { data } = await useApi('/api/claude/project-sessions' + q)
      if (data) this.projectSessions = data.sessions || []
    },
    filterProject(key) {
      this.sessionFilter = this.sessionFilter === key ? '' : key
      this.loadProjectSessions()
    },
    async loadStats() {
      const { data } = await useApi('/api/claude/stats')
      if (data) this.stats = data.stats || []
      this.scrollChartToEnd('statsChartBox')
    },
    async loadTokens() {
      const { data } = await useApi('/api/claude/tokens')
      if (data) {
        this.tokenDaily = data.daily || []
        this.modelUsage = data.model_usage || []
      }
      this.scrollChartToEnd('tokensChartBox')
    },
    scrollChartToEnd(ref) {
      this.$nextTick(() => {
        const box = this.$refs[ref]
        if (box) box.scrollLeft = box.scrollWidth
      })
    },
    async loadMemoryProjects() {
      const { data } = await useApi('/api/claude/memories/projects')
      if (data) this.memoryProjects = data.projects || []
    },
    async loadMemories() {
      const q = this.memoryProject ? `?project_key=${this.memoryProject}` : ''
      const { data } = await useApi('/api/claude/memories' + q)
      if (data) this.memories = data.memories || []
    },
    async loadHistory() {
      const { data } = await useApi('/api/claude/history')
      if (data) this.history = data.history || []
    },
    async loadSessions() {
      const { data } = await useApi('/api/claude/sessions')
      if (data) this.sessions = data.sessions || []
    },
    formatDate(iso) {
      if (!iso) return ''
      return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    },
    formatProjectKey(key) {
      if (!key || key === '-') return '-'
      return key.replace(/^g--workspace-/, '').replace(/-/g, ' ')
    },
    truncate(str, len) {
      if (!str) return ''
      return str.length > len ? str.slice(0, len) + '...' : str
    },
    formatTokens(n) {
      if (!n) return '0'
      if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
      return String(n)
    },
    memoryTypeBadge(type) {
      const map = { user: 'bg-primary', feedback: 'bg-warning text-dark', project: 'bg-success', reference: 'bg-info' }
      return map[type] || 'bg-secondary'
    }
  }
}
</script>
<style>
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
