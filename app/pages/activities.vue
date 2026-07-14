<template>
  <div>
    <h1 class="mb-3">활동</h1>

    <!-- ===== 탭 ===== -->
    <div class="nav nav-tabs mb-3" role="tablist">
      <button type="button" class="nav-link d-flex align-items-center gap-1" :class="{ active: activeTab === 'monitor' }"
        @click="activeTab = 'monitor'" role="tab" aria-selected="activeTab === 'monitor'">
        <span v-if="monitorActive.length" class="rounded-circle bg-success" style="width:8px;height:8px;flex-shrink:0;animation:pulse 1.5s infinite;"></span>
        <i v-else class="bi bi-activity me-1"></i>
        실시간 모니터<span v-if="monitorActive.length" class="badge bg-success ms-1">{{ monitorActive.length }}</span>
      </button>
      <button type="button" class="nav-link" :class="{ active: activeTab === 'commands' }"
        @click="activeTab = 'commands'" role="tab" aria-selected="activeTab === 'commands'">
        <i class="bi bi-lightning-charge me-1"></i>명령 큐
      </button>
      <button type="button" class="nav-link" :class="{ active: activeTab === 'sessions' }"
        @click="activeTab = 'sessions'" role="tab" aria-selected="activeTab === 'sessions'">
        <i class="bi bi-terminal me-1"></i>세션 로그
      </button>
      <button type="button" class="nav-link" :class="{ active: activeTab === 'logs' }"
        @click="activeTab = 'logs'" role="tab" aria-selected="activeTab === 'logs'">
        <i class="bi bi-clock-history me-1"></i>활동 로그
      </button>
    </div>

    <!-- ===== 탭 0: 실시간 모니터 ===== -->
    <template v-if="activeTab === 'monitor'" key="monitor-tab">
      <!-- Active Runs -->
      <div class="card mb-3">
        <div class="card-header d-flex align-items-center justify-content-between py-2">
          <span class="fw-semibold">
            <i class="bi bi-lightning-charge me-1 text-warning"></i>실행 중
            <span class="badge bg-success ms-1">{{ monitorActive.length }}</span>
          </span>
          <small class="text-muted">{{ monitorTimer ? '폴링 중' : '정지' }}</small>
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
    </template>

    <!-- ===== 탭 1: 명령 큐 ===== -->
    <template v-if="activeTab === 'commands'" key="commands-tab">
      <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <div class="d-flex flex-wrap align-items-center gap-2">
          <select v-model="cmdStatus" class="form-select form-select-sm" style="width:auto" @change="loadCommands">
            <option value="">전체 상태</option>
            <option value="queued">승인 대기</option>
            <option value="approved">승인됨</option>
            <option value="claimed">선택됨</option>
            <option value="running">실행 중</option>
            <option value="done">완료</option>
            <option value="failed">실패</option>
            <option value="rejected">거부</option>
            <option value="expired">만료</option>
          </select>
          <select v-model="cmdRiskLevel" class="form-select form-select-sm" style="width:auto" @change="loadCommands">
            <option value="">전체 위험도</option>
            <option value="low">낮음</option>
            <option value="medium">중간</option>
            <option value="high">높음</option>
          </select>
          <select v-model="cmdProject" class="form-select form-select-sm" style="width:auto" @change="loadCommands">
            <option value="">전체 프로젝트</option>
            <option v-for="p in cmdProjectOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <button class="btn btn-sm btn-outline-secondary" :disabled="cmdLoading" @click="loadCommands" title="새로고침">
          <i class="bi bi-arrow-clockwise"></i>
        </button>
      </div>

      <div v-if="cmdError" class="alert alert-warning py-2 px-3 small d-flex justify-content-between align-items-center">
        <span><i class="bi bi-exclamation-triangle me-1"></i>{{ cmdError }}</span>
        <a href="#" class="text-decoration-none" @click.prevent="loadCommands">다시 시도</a>
      </div>

      <div v-if="cmdLoading" class="text-center text-muted py-5">
        <span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...
      </div>

      <template v-else-if="commands.length">
        <div class="table-responsive">
          <table class="table table-sm table-hover mb-0">
            <thead class="table-light">
              <tr>
                <th style="width:10%">상태</th>
                <th style="width:35%">지시문</th>
                <th style="width:20%">프로젝트</th>
                <th style="width:10%">위험도</th>
                <th style="width:15%">시간</th>
                <th style="width:10%">결과</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="cmd in commands" :key="cmd.id" style="cursor:pointer" @click="showCommandDetail(cmd)">
                <td><span class="badge" :class="statusBadgeClass(cmd.status)">{{ statusLabel(cmd.status) }}</span></td>
                <td class="text-truncate small" :title="cmd.instruction">{{ cmd.instruction.slice(0, 60) }}</td>
                <td class="small"><router-link :to="'/projects/' + cmd.project_id" class="text-decoration-none">{{ cmdProjectName(cmd.project_id) }}</router-link></td>
                <td class="small"><span class="badge" :class="riskBadgeClass(cmd.risk_level)">{{ cmd.risk_level || 'low' }}</span></td>
                <td class="small text-muted">{{ relTime(cmd.updated_at) }}</td>
                <td class="small" v-if="cmd.result">{{ (cmd.result || '').slice(0, 20) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!cmdLoading && cmdHasMore" class="text-center mt-3">
          <button class="btn btn-outline-secondary btn-sm" :disabled="cmdLoadingMore" @click="loadMoreCommands">
            <span v-if="cmdLoadingMore" class="spinner-border spinner-border-sm me-2"></span>더 보기
          </button>
        </div>
      </template>

      <div v-else-if="!cmdLoading" class="empty-state py-5">
        <i class="bi bi-inbox empty-state-icon"></i>
        <div class="empty-state-title">
          {{ cmdStatus || cmdRiskLevel ? '조건에 맞는 명령이 없습니다.' : '아직 명령이 없습니다.' }}
        </div>
      </div>
    </template>

    <!-- ===== 탭 3: 활동 로그 ===== -->
    <template v-if="activeTab === 'logs'" key="logs-tab">
      <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <div class="d-flex flex-wrap align-items-center gap-2">
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
        <button class="btn btn-sm btn-outline-secondary" :disabled="loading" @click="reload" title="새로고침">
          <i class="bi bi-arrow-clockwise"></i>
        </button>
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
    </template>

    <!-- ===== 탭 2: 세션 로그 ===== -->
    <template v-if="activeTab === 'sessions'" key="sessions-tab">
      <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <div class="d-flex flex-wrap align-items-center gap-2">
          <input v-model="sessionSearch" type="text" class="form-control form-control-sm" placeholder="제목 검색..."
            style="width:200px" @keyup.enter="loadSessions">
          <select v-model="sessionProject" class="form-select form-select-sm" style="width:auto" @change="loadSessions">
            <option value="">전체 프로젝트</option>
            <option v-for="p in sessionProjectOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <button class="btn btn-sm btn-outline-secondary" :disabled="sessionLoading" @click="loadSessions" title="새로고침">
          <i class="bi bi-arrow-clockwise"></i>
        </button>
      </div>

      <div v-if="sessionError" class="alert alert-warning py-2 px-3 small d-flex justify-content-between align-items-center">
        <span><i class="bi bi-exclamation-triangle me-1"></i>{{ sessionError }}</span>
        <a href="#" class="text-decoration-none" @click.prevent="loadSessions">다시 시도</a>
      </div>

      <div v-if="sessionLoading" class="text-center text-muted py-5">
        <span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...
      </div>

      <template v-else-if="sessions.length">
        <div class="table-responsive">
          <table class="table table-sm table-hover mb-0">
            <thead class="table-light">
              <tr>
                <th style="width:25%">프로젝트</th>
                <th style="width:12%">브랜치</th>
                <th style="width:45%">제목 / 마지막 프롬프트</th>
                <th style="width:6%">메시지</th>
                <th style="width:6%">도구</th>
                <th style="width:6%">시간</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="session in sessions" :key="session.id" style="cursor:pointer" @click="showSessionDetail(session)">
                <td class="small text-truncate">{{ session.project_key }}</td>
                <td class="small text-muted">{{ session.git_branch || '-' }}</td>
                <td class="small">
                  <div class="text-truncate fw-medium" :title="session.title">{{ session.title || '(제목 없음)' }}</div>
                  <div class="text-truncate text-muted" style="font-size:0.85em" :title="session.last_prompt">{{ session.last_prompt ? (session.last_prompt.slice(0, 80) + (session.last_prompt.length > 80 ? '...' : '')) : '-' }}</div>
                </td>
                <td class="small text-center">{{ session.message_count || 0 }}</td>
                <td class="small text-center">{{ session.tool_count || 0 }}</td>
                <td class="small text-muted">{{ session.started_at ? formatSessionTime(session.started_at, session.ended_at) : '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!sessionLoading && sessionHasMore" class="text-center mt-3">
          <button class="btn btn-outline-secondary btn-sm" :disabled="sessionLoadingMore" @click="loadMoreSessions">
            <span v-if="sessionLoadingMore" class="spinner-border spinner-border-sm me-2"></span>더 보기
          </button>
        </div>
      </template>

      <div v-else-if="!sessionLoading" class="empty-state py-5">
        <i class="bi bi-terminal empty-state-icon"></i>
        <div class="empty-state-title">
          {{ sessionProject ? '해당 프로젝트의 세션이 없습니다.' : '아직 기록된 세션이 없습니다.' }}
        </div>
      </div>
    </template>

    <!-- 명령 상세 모달 -->
    <div v-if="detailCommand" class="modal-backdrop-custom" @click.self="detailCommand = null">
      <div class="modal-card card shadow" style="max-width:700px">
        <div class="d-flex justify-content-between align-items-center p-3 border-bottom border-hairline">
          <div>
            <i class="bi bi-lightning-charge me-2"></i>
            <span class="fw-medium">명령 상세</span>
          </div>
          <button class="btn-close" @click="detailCommand = null" aria-label="닫기"></button>
        </div>
        <div class="modal-body-scroll p-3" style="font-size:0.875rem">
          <div class="mb-3">
            <div class="text-muted small">상태</div>
            <div class="mt-1"><span class="badge" :class="statusBadgeClass(detailCommand.status)">{{ statusLabel(detailCommand.status) }}</span></div>
          </div>
          <div class="mb-3">
            <div class="text-muted small">지시문</div>
            <div class="mt-1 p-2 bg-light rounded" style="font-family:monospace;white-space:pre-wrap;word-break:break-word">{{ detailCommand.instruction }}</div>
          </div>
          <div class="mb-3">
            <div class="text-muted small">프로젝트</div>
            <div class="mt-1"><router-link :to="'/projects/' + detailCommand.project_id" class="text-decoration-none">{{ cmdProjectName(detailCommand.project_id) }}</router-link></div>
          </div>
          <div v-if="detailCommand.result" class="mb-3">
            <div class="text-muted small">결과</div>
            <div class="mt-1 p-2 bg-light rounded" style="font-family:monospace;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto">{{ detailCommand.result }}</div>
          </div>
          <div v-if="detailCommand.error" class="mb-3">
            <div class="text-muted small">오류</div>
            <div class="mt-1 p-2 bg-danger-soft rounded text-danger">{{ detailCommand.error }}</div>
          </div>
          <div class="d-flex gap-2 justify-content-between text-muted small">
            <div>생성: {{ formatDate(detailCommand.created_at) }}</div>
            <div>수정: {{ formatDate(detailCommand.updated_at) }}</div>
          </div>
        </div>
      </div>
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

    <!-- 세션 상세 모달 -->
    <div v-if="detailSession" class="modal-backdrop-custom" @click.self="detailSession = null">
      <div class="modal-card card shadow" style="max-width:900px">
        <div class="d-flex justify-content-between align-items-center p-3 border-bottom border-hairline">
          <div>
            <i class="bi bi-terminal me-2"></i>
            <span class="fw-medium">세션 상세</span>
          </div>
          <button class="btn-close" @click="detailSession = null" aria-label="닫기"></button>
        </div>
        <div class="modal-body-scroll p-3" style="font-size:0.875rem">
          <div v-if="sessionFileLoading" class="text-center text-muted py-5">
            <span class="spinner-border spinner-border-sm me-2"></span>파일 로드 중...
          </div>
          <div v-else-if="sessionFileError" class="alert alert-warning">{{ sessionFileError }}</div>
          <template v-else-if="sessionFileData">
            <!-- 세션 기본 정보 -->
            <div class="mb-3">
              <div class="text-muted small fw-semibold mb-2">세션 정보</div>
              <div class="row g-2 small">
                <div class="col-md-6">
                  <div class="text-muted">제목</div>
                  <div>{{ detailSession.title || '(제목 없음)' }}</div>
                </div>
                <div class="col-md-6">
                  <div class="text-muted">프로젝트</div>
                  <div>{{ detailSession.project_key }}</div>
                </div>
                <div class="col-md-6">
                  <div class="text-muted">브랜치</div>
                  <div>{{ detailSession.git_branch || '-' }}</div>
                </div>
                <div class="col-md-6">
                  <div class="text-muted">시간</div>
                  <div>{{ formatSessionTime(detailSession.started_at, detailSession.ended_at) }}</div>
                </div>
                <div class="col-md-6">
                  <div class="text-muted">메시지 수</div>
                  <div>{{ detailSession.message_count || 0 }}</div>
                </div>
                <div class="col-md-6">
                  <div class="text-muted">도구 사용</div>
                  <div>{{ detailSession.tool_count || 0 }}</div>
                </div>
              </div>
            </div>

            <hr class="border-hairline my-3">

            <!-- 첫 프롬프트 -->
            <div class="mb-3">
              <div class="text-muted small fw-semibold mb-2">첫 프롬프트</div>
              <div class="p-2 bg-light rounded small text-break" style="max-height:100px;overflow-y:auto">{{ detailSession.first_prompt || '-' }}</div>
            </div>

            <!-- 마지막 프롬프트 -->
            <div class="mb-3">
              <div class="text-muted small fw-semibold mb-2">마지막 프롬프트</div>
              <div class="p-2 bg-light rounded small text-break" style="max-height:100px;overflow-y:auto">{{ detailSession.last_prompt || '-' }}</div>
            </div>

            <hr class="border-hairline my-3">

            <!-- 이벤트 타입 요약 -->
            <div class="mb-3">
              <div class="text-muted small fw-semibold mb-2">파일 구성 (총 {{ sessionFileData.total_lines }}줄)</div>
              <div class="row g-2">
                <div v-for="item in sessionFileData.summary" :key="item.type" class="col-6 col-md-4">
                  <div class="p-2 border border-hairline rounded small">
                    <div class="text-muted text-truncate">{{ item.type }}</div>
                    <div class="fw-medium">{{ item.count }}건</div>
                  </div>
                </div>
              </div>
            </div>

            <hr class="border-hairline my-3">

            <!-- 파일 경로 -->
            <div class="small text-muted">
              <div class="mb-1">파일 경로</div>
              <div class="p-2 bg-light rounded font-monospace text-break" style="font-size:0.8em">{{ sessionFileData.file_path }}</div>
            </div>
          </template>
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

/* 명령 큐 테이블 */
.table tbody tr { transition: background-color 0.1s; }
.table tbody tr:hover { background-color: var(--color-canvas-soft); }

/* 파일 미리보기 모달 (프로젝트 상세와 동일 규칙 — 이 페이지 단독 로드 대비) */
.modal-backdrop-custom { position: fixed; inset: 0; z-index: 1050; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; padding: 1rem; }
.modal-backdrop-custom .modal-card { width: 100%; max-width: 900px; max-height: 85vh; display: flex; flex-direction: column; }
.modal-backdrop-custom .modal-body-scroll { overflow: auto; }
.file-preview { white-space: pre-wrap; word-break: break-word; font-size: .8125rem; line-height: 1.5; padding: 1rem 1.25rem; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>

<script>
export default {
  title: '활동',
  data() {
    return {
      activeTab: 'commands',  // 'monitor' | 'commands' | 'logs' | 'sessions'

      // ===== 실시간 모니터 =====
      monitorActive: [],
      monitorRecent: [],
      monitorLog: [],
      monitorSse: null,
      monitorTick: 0,
      monitorTimer: null,
      monitorCursors: {},

      // ===== 명령 큐 =====
      commands: [],
      cmdLoading: true,
      cmdLoadingMore: false,
      cmdError: '',
      cmdStatus: '',
      cmdRiskLevel: '',
      cmdProject: '',
      cmdProjectOptions: [],
      cmdLimit: 50,
      cmdHasMore: false,
      detailCommand: null,

      // ===== 활동 로그 =====
      activities: [],
      loading: true,
      loadingMore: false,
      error: '',
      level: 'work',
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
      limit: 50,
      hasMore: false,
      viewFile: null,
      fileLoading: false,
      fileError: '',

      // ===== 세션 로그 =====
      sessions: [],
      sessionLoading: true,
      sessionLoadingMore: false,
      sessionError: '',
      sessionSearch: '',
      sessionProject: '',
      sessionProjectOptions: [],
      sessionLimit: 50,
      sessionHasMore: false,
      detailSession: null,
      sessionFileLoading: false,
      sessionFileError: '',
      sessionFileData: null,
    }
  },
  async mounted() {
    await this.loadCommands()
    await this.loadCommandProjects()
    await this.load()
    this.loadAgents()
    await this.loadSessions()
    this.loadSessionProjects()
  },
  unmounted() {
    this.disconnectMonitor()
  },
  watch: {
    activeTab(newVal, oldVal) {
      if (oldVal === 'monitor') this.disconnectMonitor()
      if (newVal === 'monitor') this.connectMonitor()
    }
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
    formatDate(iso) {
      if (!iso) return ''
      return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    },

    // ===== 실시간 모니터 메서드 =====
    connectMonitor() {
      if (this.monitorTimer) return
      this.monitorTimer = setInterval(() => this.monitorPoll(), 1000)
      this.monitorPoll()
    },
    disconnectMonitor() {
      if (this.monitorSse) { this.monitorSse.close(); this.monitorSse = null }
      if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null }
      this.monitorCursors = {}
    },
    // 2026-07-14: 목록/상태의 권위 소스를 인메모리 execMonitor(크로스프로세스 이벤트 유실 취약)에서
    //   commands 테이블(DB, 단일 진실 소스) 폴링으로 교체. 라이브 stdout/stderr 로그 테일만 보조로
    //   기존 execMonitor 폴링(/api/monitor/log)을 유지 — 그 요청이 비어도(다른 프로세스 실행 등)
    //   상태 표시 자체는 DB 값으로 계속 정상 동작한다(degrade gracefully).
    mapCommandToRun(cmd) {
      const startedAt = Date.parse(cmd.claimed_at || cmd.created_at) || Date.now()
      const endedAt = Date.parse(cmd.updated_at) || Date.now()
      const terminal = cmd.status === 'done' || cmd.status === 'failed'
      return {
        id: cmd.id,
        projectName: cmd.project_name || '?',
        instruction: cmd.instruction || '',
        taskType: cmd.task_type || 'direct',
        status: cmd.status,
        startedAt,
        endedAt,
        durationMs: terminal ? Math.max(0, endedAt - startedAt) : null,
        costUsd: cmd.cost_usd ?? null,
      }
    },
    async monitorPoll() {
      const [activeRes, recentRes] = await Promise.all([
        useApi('/api/commands?status=claimed,running&limit=20'),
        useApi('/api/commands?status=done,failed&limit=20'),
      ])
      if (activeRes.data) this.monitorActive = (activeRes.data.commands || []).map(this.mapCommandToRun)
      if (recentRes.data) this.monitorRecent = (recentRes.data.commands || []).map(this.mapCommandToRun)

      const token = localStorage.getItem('token')
      for (const run of (this.monitorActive || [])) {
        const since = this.monitorCursors[run.id] ?? 0
        const logUrl = `/api/monitor/log/${run.id}?since=${since}` + (token ? `&token=${encodeURIComponent(token)}` : '')
        const r = await useApi(logUrl)
        if (!r.data) continue
        const { entries, total } = r.data
        this.monitorCursors[run.id] = total
        for (const entry of (entries || [])) {
          if (entry.kind === 'stderr') {
            this.pushMonitorLog({ kind: 'stderr', text: entry.text, ts: entry.ts, projectName: run.projectName }, false)
          } else {
            const replace = !!(entry.streaming && entry.blockId != null)
            this.pushMonitorLog({ ...entry, projectName: run.projectName }, replace)
          }
        }
      }
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

    // ===== 명령 큐 메서드 =====
    async loadCommands() {
      this.cmdLoading = true
      const p = new URLSearchParams()
      if (this.cmdStatus) p.set('status', this.cmdStatus)
      if (this.cmdRiskLevel) p.set('risk_level', this.cmdRiskLevel)
      if (this.cmdProject) p.set('project_id', this.cmdProject)
      p.set('limit', String(this.cmdLimit))
      const url = '/api/commands' + (p.toString() ? '?' + p.toString() : '')
      const { data, error } = await useApi(url)
      this.cmdLoading = false
      if (error) { this.cmdError = error; return }
      this.cmdError = ''
      this.commands = data.commands || []
      this.cmdHasMore = this.commands.length >= this.cmdLimit
    },
    async loadMoreCommands() {
      this.cmdLoadingMore = true
      const nextLimit = this.cmdLimit + 50
      const p = new URLSearchParams()
      if (this.cmdStatus) p.set('status', this.cmdStatus)
      if (this.cmdRiskLevel) p.set('risk_level', this.cmdRiskLevel)
      if (this.cmdProject) p.set('project_id', this.cmdProject)
      p.set('limit', String(nextLimit))
      const url = '/api/commands' + (p.toString() ? '?' + p.toString() : '')
      const { data, error } = await useApi(url)
      this.cmdLoadingMore = false
      if (error) { this.cmdError = error; return }
      this.cmdLimit = nextLimit
      this.commands = data.commands || []
      this.cmdHasMore = this.commands.length >= this.cmdLimit
    },
    async loadCommandProjects() {
      const { data } = await useApi('/api/projects')
      this.cmdProjectOptions = (data && data.projects ? data.projects : []).slice(0, 20)
    },
    cmdProjectName(projectId) {
      const p = this.cmdProjectOptions.find(x => x.id === projectId)
      return p ? p.name : projectId
    },
    statusLabel(status) {
      const MAP = {
        queued: '승인 대기',
        approved: '승인됨',
        claimed: '선택됨',
        running: '실행 중',
        done: '완료',
        failed: '실패',
        rejected: '거부',
        expired: '만료',
      }
      return MAP[status] || status
    },
    statusBadgeClass(status) {
      const MAP = {
        queued: 'bg-warning text-dark',
        approved: 'bg-info text-white',
        claimed: 'bg-primary text-white',
        running: 'bg-success text-white',
        done: 'bg-success text-white',
        failed: 'bg-danger text-white',
        rejected: 'bg-secondary text-white',
        expired: 'bg-secondary text-white',
      }
      return MAP[status] || 'bg-secondary text-white'
    },
    riskBadgeClass(risk) {
      const MAP = {
        low: 'bg-light text-dark',
        medium: 'bg-warning text-dark',
        high: 'bg-danger text-white',
      }
      return MAP[risk] || 'bg-light text-dark'
    },
    showCommandDetail(cmd) {
      this.detailCommand = cmd
    },

    // ===== 활동 로그 메서드 =====
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

    // ===== 세션 로그 메서드 =====
    async loadSessions() {
      this.sessionLoading = true
      const p = new URLSearchParams()
      if (this.sessionSearch) p.set('search', this.sessionSearch)
      if (this.sessionProject) p.set('project_id', this.sessionProject)
      p.set('limit', String(this.sessionLimit))
      const url = '/api/claude/project-sessions' + (p.toString() ? '?' + p.toString() : '')
      const { data, error } = await useApi(url)
      this.sessionLoading = false
      if (error) { this.sessionError = error; return }
      this.sessionError = ''
      this.sessions = data.sessions || []
      this.sessionHasMore = this.sessions.length >= this.sessionLimit
    },
    async loadMoreSessions() {
      this.sessionLoadingMore = true
      const nextLimit = this.sessionLimit + 50
      const p = new URLSearchParams()
      if (this.sessionSearch) p.set('search', this.sessionSearch)
      if (this.sessionProject) p.set('project_id', this.sessionProject)
      p.set('limit', String(nextLimit))
      const url = '/api/claude/project-sessions' + (p.toString() ? '?' + p.toString() : '')
      const { data, error } = await useApi(url)
      this.sessionLoadingMore = false
      if (error) { this.sessionError = error; return }
      this.sessionLimit = nextLimit
      this.sessions = data.sessions || []
      this.sessionHasMore = this.sessions.length >= this.sessionLimit
    },
    async loadSessionProjects() {
      const { data } = await useApi('/api/projects')
      this.sessionProjectOptions = (data && data.projects ? data.projects : []).slice(0, 20)
    },
    formatSessionTime(startedAt, endedAt) {
      if (!startedAt) return '-'
      const start = new Date(startedAt)
      const end = endedAt ? new Date(endedAt) : new Date()
      const diffMs = end - start
      const minutes = Math.floor(diffMs / 60000)
      const hours = Math.floor(minutes / 60)
      if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm'
      return minutes + 'm'
    },
    async showSessionDetail(session) {
      this.detailSession = session
      this.sessionFileLoading = true
      this.sessionFileError = ''
      this.sessionFileData = null

      const { data, error } = await useApi('/api/claude/project-sessions/' + session.id + '/file')
      this.sessionFileLoading = false
      if (error) {
        this.sessionFileError = '파일을 로드하지 못했습니다: ' + (error || '알 수 없는 오류')
        return
      }
      this.sessionFileData = data
    },
  }
}
</script>
