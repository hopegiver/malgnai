<template>
  <div>
    <div class="mb-3">
      <router-link to="/projects" class="text-muted small">&larr; 프로젝트 목록</router-link>
    </div>

    <div v-if="project">
      <!-- 공통 헤더 -->
      <div class="d-flex justify-content-between align-items-start mb-3">
        <div class="min-w-0">
          <h1 class="mb-1 text-truncate">{{ project.name }}</h1>
          <p class="text-muted mb-0 pd-desc-clamp">{{ project.description || '설명 없음' }}</p>
        </div>
        <div class="d-flex flex-column align-items-end gap-1 flex-shrink-0">
          <span class="badge" :class="activityBadge()" title="가동 상태 — 지금 AI가 실제로 돌고 있는지(실시간)">
            <i class="bi" :class="activityIcon()"></i>
            {{ activityLabel() }}
          </span>
          <!-- 라이프사이클(사람이 정하는 단계) — 드롭다운으로 명시적 전환. 가동상태와 직교. -->
          <div class="d-flex align-items-center gap-1">
            <template v-if="project.status === 'deleted'">
              <span class="badge bg-danger">삭제됨</span>
              <button type="button" class="btn btn-sm btn-outline-secondary" title="삭제 취소(복구)"
                      :disabled="statusSaving" @click="restoreProject">
                <i class="bi bi-arrow-counterclockwise"></i> 복구
              </button>
            </template>
            <template v-else>
              <select class="form-select form-select-sm pd-status-select" :value="project.status"
                      :disabled="statusSaving" @change="changeStatus($event.target.value)"
                      title="라이프사이클 단계 — 사람이 정하는 진행 단계">
                <option value="pending">대기</option>
                <option value="active">진행</option>
                <option value="completed">완료</option>
                <option value="on_hold">보류</option>
              </select>
            </template>
            <i v-if="statusSaving" class="bi bi-arrow-repeat spin text-muted" style="font-size:13px"></i>
          </div>
        </div>
        <div v-if="statusError" class="text-danger small text-end mb-2">{{ statusError }}</div>
      </div>

      <!-- 탭 네비게이션 -->
      <div class="pd-tabs-wrap mb-4">
      <ul class="nav pd-tabs nav-tabs-scroll" role="tablist" ref="tabbar">
        <li class="nav-item" role="presentation">
          <button class="nav-link" type="button" :class="{ active: tab === 'now' }" @click="selectTab('now')">
            <i class="bi bi-broadcast pd-tab-icon"></i>지금
          </button>
        </li>
        <li class="nav-item" role="presentation">
          <button class="nav-link" type="button" :class="{ active: tab === 'instruct' }" @click="selectTab('instruct')">
            <i class="bi bi-send pd-tab-icon"></i>지시
          </button>
        </li>
        <li class="nav-item" role="presentation">
          <button class="nav-link" type="button" :class="{ active: tab === 'monitor' }" @click="selectTab('monitor')">
            <i class="bi bi-broadcast-pin pd-tab-icon"></i>모니터링
            <span v-if="monitorActive.length" class="pd-auto-dot" title="실행 중"></span>
          </button>
        </li>
        <li class="nav-item" role="presentation">
          <button class="nav-link" type="button" :class="{ active: tab === 'journal' }" @click="selectTab('journal')">
            <i class="bi bi-journal pd-tab-icon"></i>기록
            <span v-if="journalBadge.val" class="pd-tab-count" :class="journalBadge.alert ? 'pd-tab-count--alert' : ''">{{ journalBadge.val }}</span>
          </button>
        </li>
        <li class="nav-item" role="presentation">
          <button class="nav-link" type="button" :class="{ active: tab === 'files' }" @click="selectTab('files')">
            <i class="bi bi-folder2-open pd-tab-icon"></i>파일
          </button>
        </li>
        <li class="nav-item" role="presentation">
          <button class="nav-link" type="button" :class="{ active: tab === 'settings' }" @click="selectTab('settings')">
            <i class="bi bi-gear pd-tab-icon"></i>설정
            <span v-if="isAutonomyActive" class="pd-auto-dot" title="자율 가동 중"></span>
          </button>
        </li>
      </ul>
      </div>

      <!-- ============ 지금 탭 ============ -->
      <div v-show="tab === 'now'">
        <!-- STATUS.md 가 있을 때만 표시 -->
        <div v-if="statusMd" class="card pd-status-card p-4 mb-3">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="h6 mb-0"><i class="bi bi-flag me-1"></i>현재 상태 <span class="text-faint fw-normal">STATUS.md</span></h2>
            <div class="d-flex align-items-center gap-3">
              <small v-if="statusUpdatedAt" class="text-faint text-nowrap">갱신 {{ formatDate(statusUpdatedAt) }}</small>
              <button type="button" class="btn btn-sm btn-link p-0 text-decoration-none" @click="statusExpanded = !statusExpanded">
                {{ statusExpanded ? '접기' : '펼치기' }} <i class="bi" :class="statusExpanded ? 'bi-chevron-up' : 'bi-chevron-down'"></i>
              </button>
            </div>
          </div>
          <div class="status-md-wrap">
            <div class="status-md" :class="statusExpanded ? '' : 'status-md-collapsed'" v-html="renderStatus()"></div>
            <div v-if="!statusExpanded" class="status-md-fade"></div>
          </div>
        </div>
        <template v-if="summary">
          <!-- 진행률 -->
          <div class="card pd-progress-card p-4 mb-3">
            <div class="d-flex justify-content-between align-items-end mb-2">
              <div>
                <div class="pd-kpi-label">전체 진행률</div>
                <div class="pd-progress-value">{{ summary.tasks.progress }}<span class="pd-progress-unit">%</span></div>
              </div>
              <div class="text-end">
                <div class="small text-muted">완료 {{ summary.tasks.completed }} / 전체 {{ summary.tasks.total }}</div>
                <div v-if="summary.last_activity_at" class="text-faint" style="font-size:.75rem">
                  마지막 활동 {{ formatDate(summary.last_activity_at) }}
                </div>
              </div>
            </div>
            <div class="pd-progress-track" role="progressbar"
              :aria-valuenow="summary.tasks.progress" aria-valuemin="0" aria-valuemax="100">
              <div class="pd-progress-fill" :style="{ width: summary.tasks.progress + '%' }"></div>
            </div>
            <!-- 작업 상태 분해 -->
            <div v-if="summary.tasks.total" class="d-flex flex-wrap gap-3 mt-3 small">
              <span class="text-success"><i class="bi bi-check-circle-fill me-1"></i>완료 {{ summary.tasks.completed }}</span>
              <span class="text-primary"><i class="bi bi-arrow-repeat me-1"></i>진행 {{ summary.tasks.in_progress }}</span>
              <span class="text-muted"><i class="bi bi-circle me-1"></i>대기 {{ summary.tasks.pending }}</span>
              <span v-if="summary.tasks.failed" class="text-danger fw-semibold">
                <i class="bi bi-x-circle-fill me-1"></i>실패 {{ summary.tasks.failed }}
                <a href="#" class="ms-1 small" @click.prevent="selectTab('journal')">확인 →</a>
              </span>
            </div>
          </div>

          <!-- KPI 4종 -->
          <div class="row g-3 mb-4">
            <div class="col-6 col-lg-3">
              <a href="#" class="card pd-stat pd-stat--primary p-3 text-decoration-none" @click.prevent="goProgress('commands')">
                <div class="pd-stat-top">
                  <span class="pd-stat-icon"><i class="bi bi-list-check"></i></span>
                  <span class="pd-stat-label">작업</span>
                </div>
                <div class="pd-stat-value">{{ summary.tasks.total }}</div>
                <div class="pd-stat-sub">진행 {{ summary.tasks.in_progress }} · 대기 {{ summary.tasks.pending }}</div>
              </a>
            </div>
            <div class="col-6 col-lg-3">
              <a href="#" class="card pd-stat p-3 text-decoration-none"
                :class="summary.issues.open ? 'pd-stat--danger' : 'pd-stat--neutral'" @click.prevent="selectTab('journal')">
                <div class="pd-stat-top">
                  <span class="pd-stat-icon"><i class="bi bi-exclamation-triangle"></i></span>
                  <span class="pd-stat-label">미해결 이슈</span>
                </div>
                <div class="pd-stat-value">{{ summary.issues.open }}</div>
                <div class="pd-stat-sub">전체 {{ summary.issues.total }}건</div>
              </a>
            </div>
            <div class="col-6 col-lg-3">
              <a href="#" class="card pd-stat pd-stat--info p-3 text-decoration-none" @click.prevent="goProgress('commands')">
                <div class="pd-stat-top">
                  <span class="pd-stat-icon"><i class="bi bi-terminal"></i></span>
                  <span class="pd-stat-label">명령</span>
                </div>
                <div class="pd-stat-value">{{ summary.commands.active || summary.commands.total }}</div>
                <div class="pd-stat-sub">
                  {{ summary.commands.active ? '실행중 · 전체 ' + summary.commands.total : '누적 실행' }}<span v-if="summary.commands.failed" class="text-danger"> · 실패 {{ summary.commands.failed }}</span>
                </div>
              </a>
            </div>
            <div class="col-6 col-lg-3">
              <div class="card pd-stat pd-stat--success p-3">
                <div class="pd-stat-top">
                  <span class="pd-stat-icon"><i class="bi bi-coin"></i></span>
                  <span class="pd-stat-label">사용량 <span class="text-faint">(환산)</span></span>
                </div>
                <div class="pd-stat-value">${{ Number(summary.commands.cost_usd || 0).toFixed(2) }}</div>
                <div class="pd-stat-sub">명령 {{ summary.commands.total }}건 · API 종량 환산</div>
              </div>
            </div>
          </div>

          <div class="row g-3 mb-4">
            <!-- 최근 활동 -->
            <div class="col-12 col-lg-7">
              <div class="card p-4 h-100">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <h2 class="h6 mb-0">최근 활동 <span class="text-faint fw-normal small">통합</span></h2>
                  <a href="#" class="small text-decoration-none" @click.prevent="goProgress('timeline')">전체 보기 →</a>
                </div>
                <div v-if="timelineLoading && !timeline.length" class="text-muted small">
                  <span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...
                </div>
                <div v-else-if="timeline.length" class="pd-list">
                  <div v-for="ev in timeline.slice(0, 5)" :key="ev.source + ':' + ev.id" class="pd-item pd-item--static">
                    <span class="pd-item-dot" :class="'pd-dot--' + sourceMeta(ev.source).color"><i class="bi" :class="sourceMeta(ev.source).icon"></i></span>
                    <div class="pd-item-body">
                      <div class="pd-item-title pd-clamp-2">{{ ev.title }}</div>
                      <div class="pd-item-meta d-flex flex-wrap align-items-center gap-2">
                        <span>{{ sourceMeta(ev.source).label }}</span>
                        <span v-if="ev.agent_name"><i class="bi bi-robot"></i> {{ ev.agent_name }}</span>
                        <span v-if="catMeta(ev.category)" class="badge act-cat-badge"
                          :style="{ color: catMeta(ev.category).fg, backgroundColor: catMeta(ev.category).bg }">{{ catMeta(ev.category).label }}</span>
                      </div>
                    </div>
                    <div class="pd-item-right"><small class="text-faint text-nowrap">{{ formatDate(ev.ts) }}</small></div>
                  </div>
                </div>
                <p v-else class="text-muted mb-0 small">활동 기록이 없습니다.</p>
              </div>
            </div>
            <!-- 미해결 이슈 미리보기 -->
            <div class="col-12 col-lg-5">
              <div class="card p-4 h-100">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <h2 class="h6 mb-0">미해결 이슈</h2>
                  <a v-if="openIssues.length" href="#" class="small text-decoration-none" @click.prevent="selectTab('journal')">전체 →</a>
                </div>
                <div v-if="openIssues.length" class="pd-list">
                  <div v-for="i in openIssues.slice(0, 4)" :key="i.id" class="pd-item pd-item--static">
                    <span class="pd-item-dot" :class="'pd-dot--' + issueColor(i)"><i class="bi bi-exclamation-circle"></i></span>
                    <div class="pd-item-body">
                      <div class="pd-item-title pd-clamp-2">{{ i.title }}</div>
                      <div v-if="i.related_file" class="pd-item-meta font-monospace">{{ i.related_file }}</div>
                    </div>
                    <div class="pd-item-right"><span :class="'badge bg-' + issueColor(i)">{{ i.severity || 'open' }}</span></div>
                  </div>
                </div>
                <p v-else class="text-success mb-0 small"><i class="bi bi-check2-circle me-1"></i>미해결 이슈 없음</p>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="row g-3">
          <div v-for="n in 4" :key="n" class="col-6 col-lg-3">
            <div class="card p-3 placeholder-glow"><span class="placeholder col-7 mb-2"></span><span class="placeholder col-4" style="height:1.75rem"></span></div>
          </div>
        </div>
      </div>

      <!-- ============ 지시 탭 ============ -->
      <div v-show="tab === 'instruct'">
        <div class="card p-4 mb-3">
          <h2 class="h6 mb-3">무엇을 시킬까요?</h2>
          <div class="btn-group w-100 mb-4" role="group">
            <button type="button" class="btn" :class="assignMode === 'task' ? 'btn-primary' : 'btn-outline-secondary'"
              @click="assignMode = 'task'"><i class="bi bi-card-checklist me-1"></i>작업 카드 만들기</button>
            <button type="button" class="btn" :class="assignMode === 'command' ? 'btn-primary' : 'btn-outline-secondary'"
              @click="assignMode = 'command'"><i class="bi bi-terminal me-1"></i>로컬에 직접 명령</button>
          </div>

          <!-- 작업 카드 만들기 -->
          <div v-show="assignMode === 'task'">
            <div class="mb-3">
              <label class="form-label small fw-medium">제목 <span class="text-danger">*</span></label>
              <input v-model="newTask.title" class="form-control" maxlength="200" placeholder="예: 랜딩페이지 카피 작성">
            </div>
            <div class="mb-3">
              <label class="form-label small fw-medium">담당 AI 직원</label>
              <select v-model="newTask.agent_name" class="form-select">
                <option value="">미배정</option>
                <option v-for="ag in agents" :key="ag.name" :value="ag.name">{{ ag.name }} — {{ ag.role }}</option>
              </select>
            </div>
            <div class="mb-3">
              <label class="form-label small fw-medium">상세 지시</label>
              <textarea v-model="newTask.description" class="form-control" rows="3" maxlength="2000"
                placeholder="작업 내용을 구체적으로 적어주세요..."></textarea>
            </div>
            <div v-if="taskError" class="alert alert-warning py-2 px-3 small">{{ taskError }}</div>
            <div class="d-flex justify-content-between align-items-center">
              <small class="text-faint">{{ (newTask.description || '').length }}/2000</small>
              <button class="btn btn-primary" :disabled="!newTask.title.trim() || submittingTask" @click="submitTask">작업 지시하기</button>
            </div>
          </div>

          <!-- 로컬 명령 -->
          <div v-show="assignMode === 'command'">
            <div class="mb-2">
              <label class="form-label small fw-medium">지시문</label>
              <textarea v-model="newCommand" class="form-control" rows="6" maxlength="4000"
                placeholder="로컬에서 실행할 명령(지시문)을 입력하세요..."></textarea>
            </div>
            <div class="alert alert-warning py-2 px-3 small mb-2">
              <i class="bi bi-exclamation-triangle me-1"></i>로컬 Claude가 <strong>승인함을 거치지 않고 즉시</strong> 실행합니다(자가승인). 비용이 발생할 수 있습니다.
            </div>
            <div v-if="commandError" class="alert alert-warning py-2 px-3 small">{{ commandError }}</div>
            <div class="d-flex justify-content-between align-items-center">
              <small class="text-faint">{{ newCommand.length }}/4000</small>
              <button class="btn btn-primary" :disabled="!newCommand.trim() || submittingCommand" @click="submitCommand">명령 보내기</button>
            </div>
          </div>
        </div>

        <div v-if="assignNotice" class="alert alert-success py-2 px-3 small d-flex justify-content-between align-items-center">
          <span><i class="bi bi-check-circle me-1"></i>{{ assignNotice }}</span>
          <a href="#" class="text-decoration-none" @click.prevent="selectTab('journal')">기록 보기 →</a>
        </div>
      </div>

      <!-- ============ 모니터링 탭 (이 프로젝트로 스코핑된 실시간 실행 모니터) ============ -->
      <div v-show="tab === 'monitor'">
        <div class="card mb-3">
          <div class="card-header d-flex align-items-center justify-content-between py-2">
            <span class="fw-semibold"><i class="bi bi-lightning-charge me-1 text-warning"></i>실행 중</span>
            <small class="text-muted">{{ monitorTimer ? '폴링 중' : '정지' }}</small>
          </div>
          <div v-if="!monitorActive.length" class="text-center text-muted py-4 small">
            <i class="bi bi-pause-circle me-1"></i>현재 이 프로젝트에서 실행 중인 AI 작업이 없습니다.
          </div>
          <div v-for="run in monitorActive" :key="run.id" class="p-3 border-bottom">
            <div class="d-flex align-items-start justify-content-between gap-2">
              <div style="min-width:0;">
                <span class="badge" :class="run.taskType === 'project_cycle' ? 'bg-info' : 'bg-primary'">{{ run.taskType === 'project_cycle' ? 'AI 자율' : '직접 명령' }}</span>
                <div class="text-muted small mt-1" style="word-break:break-word;">{{ run.instruction.slice(0, 200) }}{{ run.instruction.length > 200 ? '…' : '' }}</div>
              </div>
              <div class="text-end flex-shrink-0">
                <div class="fw-bold text-warning font-monospace" style="font-size:1.1rem;">{{ formatElapsed(run.startedAt) }}</div>
                <small class="text-muted">경과</small>
              </div>
            </div>
          </div>
        </div>

        <div v-if="monitorLog.length" class="card mb-3">
          <div class="card-header d-flex align-items-center justify-content-between py-2">
            <span class="fw-semibold"><i class="bi bi-terminal me-1"></i>진행 로그</span>
            <button class="btn btn-sm btn-outline-secondary py-0 px-2" @click="monitorLog = []">지우기</button>
          </div>
          <div class="p-2" style="max-height:320px;overflow-y:auto;background:#111;border-radius:0 0 8px 8px;" ref="pmLogBox">
            <div v-for="(line, i) in monitorLog" :key="i" class="d-flex align-items-start gap-2 mb-1" style="font-size:0.75rem;">
              <i class="bi" :class="monitorLogIcon(line.kind)"></i>
              <span class="font-monospace" :class="line.isError ? 'text-danger' : 'text-light'" style="white-space:pre-wrap;word-break:break-word;">
                <strong v-if="line.kind === 'tool_call'">{{ line.tool }}</strong><span v-if="line.kind === 'tool_call' && line.detail"> — {{ line.detail }}</span>
                <span v-else>{{ line.text || line.detail }}</span>
              </span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header py-2 fw-semibold"><i class="bi bi-check2-circle me-1 text-success"></i>최근 완료</div>
          <div v-if="!monitorRecent.length" class="text-center text-muted py-4 small">완료된 작업이 없습니다.</div>
          <div v-else class="table-responsive">
            <table class="table table-sm mb-0">
              <thead><tr><th>상태</th><th>종류</th><th>명령</th><th class="text-end">소요</th><th class="text-end">비용</th></tr></thead>
              <tbody>
                <tr v-for="run in monitorRecent" :key="run.id + run.endedAt">
                  <td><span class="badge" :class="run.status === 'done' ? 'bg-success' : 'bg-danger'">{{ run.status === 'done' ? '완료' : '실패' }}</span></td>
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

      <!-- ============ 기록 탭 ============ -->
      <div v-show="tab === 'journal'">
        <div class="d-flex align-items-center gap-2 mb-3">
          <div class="btn-group pd-subseg flex-wrap" role="group">
            <button v-for="seg in progressSegs" :key="seg.key" type="button" class="btn btn-sm"
              :class="progressSeg === seg.key ? 'btn-primary' : 'btn-outline-secondary'"
              @click="onProgressSegClick(seg.key)">{{ seg.label }}</button>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary flex-shrink-0" @click="refreshJournal" :disabled="journalRefreshing" title="새로고침">
            <i class="bi" :class="journalRefreshing ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'"></i>
          </button>
        </div>

        <!-- 통합 타임라인 (4원천 UNION) -->
        <div v-show="progressSeg === 'timeline'" class="card p-4">
          <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
            <div class="small text-muted">
              <template v-if="timelineCounts">
                활동 {{ timelineCounts.activity || 0 }} · 대화 {{ timelineCounts.session || 0 }} · 명령 {{ timelineCounts.command || 0 }}
              </template>
            </div>
            <div class="form-check form-switch mb-0">
              <input class="form-check-input" type="checkbox" id="tlTelemetry" v-model="timelineIncludeTelemetry" @change="loadTimeline()">
              <label class="form-check-label small text-muted" for="tlTelemetry">시스템 이벤트 포함</label>
            </div>
          </div>

          <div v-if="timelineSourcesFailed.length" class="alert alert-warning py-2 px-3 small">
            <i class="bi bi-exclamation-triangle me-1"></i>일부 원천을 불러오지 못했습니다: {{ timelineSourcesFailed.join(', ') }} (나머지는 정상 표시)
          </div>

          <div v-if="timelineLoading && !timeline.length" class="text-muted text-center py-4">
            <span class="spinner-border spinner-border-sm me-2"></span>타임라인을 불러오는 중...
          </div>
          <div v-else-if="timelineError" class="alert alert-warning py-2 px-3 small mb-0">{{ timelineError }}</div>
          <template v-else-if="timeline.length">
            <div class="pd-list">
              <div v-for="ev in timelineRows" :key="ev.source + ':' + ev.id" class="pd-item pd-item--static"
                :class="{ 'tl-grouped': ev._grouped }">
                <span class="pd-item-dot" :class="'pd-dot--' + sourceMeta(ev.source).color" :title="sourceMeta(ev.source).label">
                  <i class="bi" :class="sourceMeta(ev.source).icon"></i>
                </span>
                <div class="pd-item-body">
                  <div class="pd-item-title pd-clamp-2">{{ ev.title }}</div>
                  <div class="pd-item-meta d-flex flex-wrap align-items-center gap-2">
                    <span class="tl-source-tag">{{ sourceMeta(ev.source).label }}</span>
                    <span v-if="ev.agent_name"><i class="bi bi-robot"></i> {{ ev.agent_name }}</span>
                    <span v-if="catMeta(ev.category)" class="badge act-cat-badge"
                      :style="{ color: catMeta(ev.category).fg, backgroundColor: catMeta(ev.category).bg }">
                      <i class="bi" :class="catMeta(ev.category).icon"></i>{{ catMeta(ev.category).label }}
                    </span>
                    <span v-if="resMeta(ev.result)" class="badge" :class="resMeta(ev.result).cls">{{ resMeta(ev.result).label }}</span>
                    <code v-if="ev.target_ref" class="tl-target">{{ ev.target_ref }}</code>
                  </div>
                </div>
                <div class="pd-item-right"><small class="text-faint text-nowrap">{{ formatDate(ev.ts) }}</small></div>
              </div>
            </div>

            <!-- 세션 매핑 실패 힌트 -->
            <div v-if="timelineCounts && !timelineCounts.session && project" class="alert alert-light border mt-3 py-2 px-3 small mb-0">
              <i class="bi bi-info-circle me-1"></i>이 프로젝트 폴더의 대화 이력 매칭 없음
              <span v-if="project.path" class="text-faint">(경로: <code>{{ project.path }}</code>)</span>
            </div>

            <div v-if="timelineHasMore" class="text-center mt-3">
              <button class="btn btn-outline-secondary btn-sm" :disabled="timelineLoadingMore" @click="loadMoreTimeline">
                <span v-if="timelineLoadingMore" class="spinner-border spinner-border-sm me-2"></span>더 보기
              </button>
            </div>
          </template>
          <p v-else class="text-muted text-center py-4 mb-0">표시할 이력이 없습니다.</p>
        </div>

        <!-- 명령 -->
        <div v-show="progressSeg === 'commands'" class="card p-4">
          <div v-if="commandError && !commands.length" class="alert alert-warning py-2 px-3 small mb-0">{{ commandError }}</div>
          <div v-else-if="commands.length">
            <div v-for="cmd in commands" :key="cmd.id" class="py-2 border-bottom border-hairline">
              <div class="d-flex justify-content-between align-items-start gap-2">
                <span class="fw-medium" style="white-space: pre-wrap; word-break: break-word;">{{ cmd.instruction }}</span>
                <div class="d-flex align-items-center gap-2 flex-shrink-0">
                  <span :class="'badge bg-' + commandStatusColor(cmd.status)">{{ commandStatusLabel(cmd.status) }}</span>
                  <button v-if="['running', 'claimed', 'approved'].includes(cmd.status)"
                    class="btn btn-sm btn-outline-danger py-0 px-2"
                    @click="terminateCommand(cmd.id)"
                    :disabled="terminatingId === cmd.id"
                    title="명령 강제 종료">
                    <span v-if="terminatingId === cmd.id" class="spinner-border spinner-border-sm"></span>
                    <i v-else class="bi bi-stop-fill"></i>
                  </button>
                  <button v-if="cmd.status === 'failed'"
                    class="btn btn-sm btn-outline-secondary py-0 px-2"
                    @click="retryCommand(cmd.id)"
                    :disabled="retryingId === cmd.id"
                    title="명령 재실행">
                    <span v-if="retryingId === cmd.id" class="spinner-border spinner-border-sm"></span>
                    <i v-else class="bi bi-arrow-clockwise"></i>
                  </button>
                  <small class="text-faint text-nowrap">{{ formatDate(cmd.created_at) }}</small>
                </div>
              </div>
              <div v-if="isCommandFinished(cmd.status)" class="mt-1">
                <div class="d-flex flex-wrap gap-3">
                  <small class="text-muted" v-if="cmd.exit_code !== null && cmd.exit_code !== undefined">종료 코드 {{ cmd.exit_code }}</small>
                  <small class="text-muted" v-if="cmd.cost_usd !== null && cmd.cost_usd !== undefined">${{ Number(cmd.cost_usd).toFixed(4) }}</small>
                </div>
                <small v-if="cmd.result" class="text-muted d-block mt-1" style="white-space: pre-wrap; word-break: break-word;">{{ cmd.result }}</small>
                <small v-if="cmd.error" class="text-danger d-block mt-1" style="white-space: pre-wrap; word-break: break-word;">{{ cmd.error }}</small>
              </div>
            </div>
          </div>
          <div v-else class="text-muted text-center py-4">
            실행한 명령이 없습니다. <a href="#" @click.prevent="selectTab('instruct')">로컬에 명령 보내기</a>
          </div>
        </div>

        <!-- 활동 -->
        <div v-show="progressSeg === 'activities'" class="card p-4">
          <div v-if="activities.length" class="pd-list">
            <div v-for="a in activities" :key="a.id" class="pd-item pd-item--static">
              <span class="pd-item-dot pd-dot--info"><i class="bi bi-activity"></i></span>
              <div class="pd-item-body">
                <div class="pd-item-title pd-clamp-2">{{ a.action }}{{ a.detail ? ' — ' + a.detail : '' }}</div>
                <div class="pd-item-meta"><i class="bi bi-robot"></i> {{ a.agent_name }}</div>
              </div>
              <div class="pd-item-right"><small class="text-faint text-nowrap">{{ formatDate(a.created_at) }}</small></div>
            </div>
          </div>
          <p v-else class="text-muted text-center py-4 mb-0">활동 기록이 없습니다.</p>
        </div>

        <!-- 세션 -->
        <div v-show="progressSeg === 'sessions'" class="card p-4">
          <div v-if="sessions.length">
            <div v-for="s in sessions" :key="s.id" class="py-2 border-bottom border-hairline">
              <div class="d-flex justify-content-between align-items-start gap-2">
                <span class="fw-medium">{{ s.title }}</span>
                <small class="text-faint text-nowrap">{{ formatDateTime(s.started_at) }}</small>
              </div>
              <div class="d-flex flex-wrap gap-3 mt-1">
                <small class="text-muted">메시지 {{ s.message_count }}</small>
                <small class="text-muted" v-if="s.tool_count">도구 {{ s.tool_count }}</small>
                <small class="text-muted" v-if="s.git_branch">{{ s.git_branch }}</small>
              </div>
            </div>
          </div>
          <p v-else class="text-muted text-center py-4 mb-0">동기화된 작업 이력이 없습니다. <code>npm run sync-claude</code> 실행 후 표시됩니다.</p>
        </div>

        <!-- 결정 서브탭 -->
        <div v-show="progressSeg === 'decisions'" class="card p-4">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="h6 mb-0"><i class="bi bi-signpost-split me-1"></i>결정</h2>
            <small v-if="decisions.length" class="text-faint">{{ decisions.length }}</small>
          </div>
          <div v-if="decisions.length" class="pd-list">
            <div v-for="d in decisions" :key="d.id" class="py-2 border-bottom border-hairline">
              <div class="d-flex justify-content-between align-items-start gap-2">
                <span class="fw-medium small">{{ d.title }}</span>
                <small class="text-faint text-nowrap">{{ formatDate(d.created_at) }}</small>
              </div>
              <small v-if="d.summary" class="text-muted d-block">{{ d.summary }}</small>
              <small v-if="d.reason" class="text-faint d-block mt-1">이유: {{ d.reason }}</small>
            </div>
          </div>
          <p v-else class="text-muted mb-0 small">기록된 결정이 없습니다.</p>
        </div>

        <!-- 이슈 서브탭 -->
        <div v-show="progressSeg === 'issues'" class="card p-4">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="h6 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>이슈</h2>
            <div class="form-check form-switch mb-0">
              <input class="form-check-input" type="checkbox" id="issueOpenOnly" v-model="issueOpenOnly">
              <label class="form-check-label small text-muted" for="issueOpenOnly">열림만</label>
            </div>
          </div>
          <div v-if="filteredIssues.length" class="pd-list">
            <div v-for="i in filteredIssues" :key="i.id" class="py-2 border-bottom border-hairline">
              <div class="d-flex justify-content-between align-items-start gap-2">
                <span class="fw-medium small">{{ i.title }}</span>
                <div class="d-flex align-items-center gap-2 flex-shrink-0">
                  <span :class="'badge bg-' + issueColor(i)">{{ i.status === 'open' ? i.severity || 'open' : '해결' }}</span>
                  <small class="text-faint text-nowrap">{{ formatDate(i.created_at) }}</small>
                </div>
              </div>
              <small v-if="i.description" class="text-muted d-block">{{ i.description }}</small>
              <small v-if="i.related_file" class="text-faint d-block font-monospace">{{ i.related_file }}</small>
            </div>
          </div>
          <p v-else class="text-muted mb-0 small">{{ issueOpenOnly ? '열린 이슈가 없습니다.' : '기록된 이슈가 없습니다.' }}</p>
        </div>

        <!-- 메모리 서브탭 -->
        <div v-show="progressSeg === 'memories'" class="card p-4">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="h6 mb-0"><i class="bi bi-bookmark me-1"></i>메모리</h2>
            <small v-if="memories.length" class="text-faint">{{ memories.length }}</small>
          </div>
          <div v-if="memories.length" class="pd-list">
            <div v-for="m in memories" :key="m.id" class="py-2 border-bottom border-hairline">
              <div class="d-flex justify-content-between align-items-start gap-2">
                <span class="fw-medium small">{{ m.title }}</span>
                <div class="d-flex align-items-center gap-2 flex-shrink-0">
                  <span v-if="m.memory_type" class="badge bg-light text-dark">{{ m.memory_type }}</span>
                  <small class="text-faint text-nowrap">{{ formatDate(m.created_at) }}</small>
                </div>
              </div>
              <small v-if="m.content" class="text-muted d-block">{{ m.content }}</small>
              <small v-if="m.tags" class="text-faint d-block mt-1">#{{ m.tags }}</small>
            </div>
          </div>
          <p v-else class="text-muted mb-0 small">기록된 메모리가 없습니다.</p>
        </div>
      </div>

      <!-- ============ 설정 탭 (프로젝트별 자율 전환 설정) ============ -->
      <div v-show="tab === 'settings'">
        <div v-if="autonomyLoading && !autonomy" class="text-muted py-5 text-center">
          <span class="spinner-border spinner-border-sm me-2"></span>자율 설정을 불러오는 중…
        </div>

        <template v-else-if="autonomy">
          <!-- 현재 상태 배너 + 토글 -->
          <div class="card p-4 mb-3 pa-switch" :class="autonomy.autonomy_enabled ? 'pa-switch--on' : 'pa-switch--off'">
            <div class="d-flex align-items-center gap-3 flex-wrap">
              <div class="pa-switch-icon" :class="autonomy.autonomy_enabled ? 'text-success' : 'text-muted'">
                <i :class="autonomy.autonomy_enabled ? 'bi bi-broadcast' : 'bi bi-pause-circle'"></i>
              </div>
              <div class="flex-grow-1" style="min-width: 0;">
                <div class="pa-switch-state" :class="autonomy.autonomy_enabled ? 'text-success' : 'text-ink-muted'">
                  {{ autonomy.autonomy_enabled ? '이 업무는 자율 가동 중' : '이 업무는 자율 정지' }}
                </div>
                <div class="small text-muted">
                  {{ autonomy.autonomy_enabled
                    ? '심장박동마다 LEAD 가 스스로 이 업무의 할 일을 판단·배정합니다.'
                    : '자율이 꺼져 있어 이 업무는 자동 배정되지 않습니다.' }}
                  <span v-if="!globalAutonomyEnabled" class="d-block text-warning mt-1">
                    <i class="bi bi-exclamation-triangle me-1"></i>전역 자율 마스터 스위치가 꺼져 있어, 켜도 실제 실행은 마스터를 켜야 시작됩니다.
                  </span>
                </div>
              </div>
              <button type="button" class="btn btn-lg pa-switch-btn"
                :class="autonomy.autonomy_enabled ? 'btn-danger' : 'btn-success'"
                :disabled="autonomyToggling"
                @click="openAutonomyConfirm(!autonomy.autonomy_enabled)">
                <span v-if="autonomyToggling" class="spinner-border spinner-border-sm me-2"></span>
                <i v-else :class="autonomy.autonomy_enabled ? 'bi bi-power me-2' : 'bi bi-play-fill me-2'"></i>
                {{ autonomy.autonomy_enabled ? '자율 끄기' : '자율 켜기' }}
              </button>
            </div>
          </div>

          <!-- 저장 성공/실패 알림 -->
          <div v-if="autonomyNotice" class="alert alert-success py-2 px-3 small d-flex justify-content-between align-items-center">
            <span><i class="bi bi-check-circle me-1"></i>{{ autonomyNotice }}</span>
            <button type="button" class="btn-close" aria-label="닫기" @click="autonomyNotice = ''"></button>
          </div>
          <div v-if="autonomyError" class="alert alert-warning py-2 px-3 small d-flex justify-content-between align-items-center">
            <span><i class="bi bi-exclamation-triangle me-1"></i>{{ autonomyError }}</span>
            <button type="button" class="btn-close" aria-label="닫기" @click="autonomyError = ''"></button>
          </div>

          <!-- 설정 폼 -->
          <div class="card p-4">
            <h2 class="h6 mb-3"><i class="bi bi-sliders me-1"></i>자율 운영 설정</h2>

            <!-- 목표 -->
            <div class="mb-3">
              <label class="form-label small fw-medium">목표 (goal) <span class="text-danger">*</span></label>
              <textarea v-model="autonomyForm.goal" class="form-control" rows="4" maxlength="2000"
                placeholder="예: 내부 운영 이슈를 매일 점검하고 위험도 높은 항목을 먼저 처리한다"></textarea>
              <div class="form-text small">LEAD 가 판단의 기준으로 삼는 북극성입니다. 자율을 켜려면 측정 가능한 목표가 필요합니다.</div>
            </div>

            <!-- 이 프로젝트만의 추가 지시 -->
            <div class="mb-3">
              <label class="form-label small fw-medium">이 프로젝트만의 추가 지시 <span class="text-faint fw-normal">(선택)</span></label>
              <textarea v-model="autonomyForm.custom_instruction" class="form-control" rows="3" maxlength="4000"
                placeholder="예: 이 프로젝트는 배포 전 항상 대표 승인을 받는다"></textarea>
              <div class="form-text small">공통 자율 운영 지침 뒤에 보충되는 이 프로젝트만의 예외 지시입니다. 없으면 비워두세요.</div>
            </div>

            <!-- KPI (지표명 + 목표값 행 편집) -->
            <div class="mb-3">
              <label class="form-label small fw-medium">핵심 지표 (KPI)</label>
              <div v-for="(row, idx) in autonomyForm.kpiRows" :key="idx" class="d-flex gap-2 mb-2">
                <input v-model="row.code" class="form-control form-control-sm" style="flex: 2;" list="kpiCodeOptions"
                  placeholder="지표명 (예: 미해결이슈, 목록에서 선택 또는 직접입력)">
                <input v-model="row.target" class="form-control form-control-sm" style="flex: 1;"
                  placeholder="목표값 (예: 0)">
                <input v-model="row.unit" class="form-control form-control-sm" style="flex: 1;" list="kpiUnitOptions"
                  placeholder="단위 (선택)">
                <button type="button" class="btn btn-sm btn-outline-secondary flex-shrink-0"
                  @click="removeKpiRow(idx)" aria-label="지표 삭제"><i class="bi bi-x-lg"></i></button>
              </div>
              <datalist id="kpiCodeOptions">
                <option v-for="opt in kpiCodeSuggestions" :key="opt" :value="opt"></option>
              </datalist>
              <datalist id="kpiUnitOptions">
                <option v-for="opt in kpiUnitSuggestions" :key="opt" :value="opt"></option>
              </datalist>
              <button type="button" class="btn btn-sm btn-outline-primary" @click="addKpiRow">
                <i class="bi bi-plus-lg me-1"></i>지표 추가
              </button>
              <div class="form-text small">지표명과 목표값을 입력하세요(목록에서 골라도, 직접 타이핑해도 됩니다). 비워두면 저장되지 않습니다.</div>
            </div>

            <!-- 관찰 에이전트 (LEAD) -->
            <div class="mb-3">
              <label class="form-label small fw-medium">관찰 에이전트 (LEAD) <span class="text-danger">*</span></label>
              <select v-model="autonomyForm.lead_agent_name" class="form-select">
                <option :value="null">— 미지정 —</option>
                <option v-for="ag in agents" :key="ag.name" :value="ag.name">{{ ag.name }}{{ ag.role ? ' — ' + ag.role : '' }}</option>
              </select>
              <div class="form-text small">이 업무를 관찰·판단할 에이전트입니다. 자율을 켜려면 반드시 지정해야 합니다.</div>
            </div>

            <!-- 박동 주기 -->
            <div class="mb-3">
              <label class="form-label small fw-medium">박동 주기 (cadence)</label>
              <select v-model="autonomyForm.cadence" class="form-select">
                <option value="every15m">15분마다</option>
                <option value="every30m">30분마다</option>
                <option value="hourly">매시</option>
                <option value="every3h">3시간마다</option>
                <option value="every6h">6시간마다</option>
                <option value="every12h">12시간마다</option>
                <option value="daily">매일</option>
                <option value="weekly">매주</option>
                <option value="off">끄기 (사이클 생성 안 함)</option>
              </select>
              <div class="form-text small">얼마나 자주 LEAD 가 이 업무를 점검할지 정합니다. '끄기'는 자율 정지와 동일하게 취급됩니다.</div>
            </div>

            <!-- 위험도 승인 임계값 -->
            <div class="mb-3">
              <label class="form-label small fw-medium">위험도 승인 임계값 (risk_approval_threshold)</label>
              <select v-model="autonomyForm.risk_approval_threshold" class="form-select">
                <option value="off">위험도 무관 자동집행 (게이트 끔)</option>
                <option value="low">모든 제안 승인 필요</option>
                <option value="medium">medium 이상 승인 필요</option>
                <option value="high">high 이상 승인 필요 (권장, 기본값)</option>
                <option value="critical">critical만 승인 필요</option>
              </select>
              <div class="form-text small">risk_level은 자율 워커가 스스로 제안에 매기는 위험도 자체평가값이며, 여기서 설정한 등급 이상은 최소안전 게이트를 통과해도 항상 사람 승인함으로 갑니다.</div>
            </div>

            <!-- KPI 전부 달성 시 동작 -->
            <div class="mb-3">
              <label class="form-label small fw-medium">모든 KPI 달성 시 동작 (kpi_complete_action)</label>
              <select v-model="autonomyForm.kpi_complete_action" class="form-select">
                <option value="continue">계속 자율 운영 (권장, 기본값)</option>
                <option value="off">자율 운영 자동 종료</option>
              </select>
              <div class="form-text small">'계속 자율 운영'을 고르면 모든 KPI를 달성해도 자율이 꺼지지 않고 다음 개선을 계속 찾습니다. '자동 종료'는 목표 달성으로 보고 자율을 끕니다(1회성 프로젝트에 적합).</div>
            </div>

            <div class="d-flex justify-content-end gap-2">
              <button type="button" class="btn btn-outline-secondary" :disabled="autonomySaving" @click="resetAutonomyForm">
                되돌리기
              </button>
              <button type="button" class="btn btn-primary" :disabled="autonomySaving" @click="saveAutonomy(false)">
                <span v-if="autonomySaving" class="spinner-border spinner-border-sm me-2"></span>설정 저장
              </button>
            </div>
          </div>
        </template>

        <div v-else-if="autonomyError" class="alert alert-warning">
          {{ autonomyError }}
          <a href="#" class="ms-2" @click.prevent="loadAutonomy">다시 시도</a>
        </div>

        <!-- 위험 구역: 프로젝트 삭제/복구 -->
        <div class="card p-4 mt-3 border-danger-subtle">
          <h2 class="h6 mb-2 text-danger"><i class="bi bi-exclamation-triangle me-1"></i>위험 구역</h2>

          <template v-if="project.status === 'deleted'">
            <div class="d-flex justify-content-between align-items-center gap-3 flex-wrap">
              <div class="small text-muted" style="max-width: 32rem;">
                이 프로젝트는 삭제 처리되어 목록에서 숨겨져 있습니다. 복구하면 다시 목록에 표시됩니다.
              </div>
              <button type="button" class="btn btn-outline-secondary flex-shrink-0"
                      :disabled="statusSaving" @click="restoreProject">
                <i class="bi bi-arrow-counterclockwise me-1"></i>복구
              </button>
            </div>
          </template>
          <template v-else>
            <div class="d-flex justify-content-between align-items-center gap-3 flex-wrap" v-if="!deleteConfirmOpen">
              <div class="small text-muted" style="max-width: 32rem;">
                프로젝트를 삭제 처리합니다. 실제 폴더나 이력(decisions/issues/memories)은 지워지지 않고 목록에서만 숨겨지며, 언제든 복구할 수 있습니다.
              </div>
              <button type="button" class="btn btn-outline-danger flex-shrink-0"
                      :disabled="statusSaving" @click="openDeleteConfirm">
                <i class="bi bi-trash me-1"></i>프로젝트 삭제
              </button>
            </div>
            <template v-else>
              <div class="mb-2">
                <label class="form-label small fw-medium mb-1">
                  삭제하려면 폴더명 <code>{{ projectFolderName }}</code> 을(를) 정확히 입력하세요
                </label>
                <input v-model="deleteConfirmText" ref="deleteConfirmInput" type="text" class="form-control form-control-sm"
                       style="max-width: 24rem;" :placeholder="projectFolderName" autocomplete="off"
                       @keyup.enter="deleteProject" @keyup.esc="closeDeleteConfirm">
              </div>
              <div class="d-flex gap-2">
                <button type="button" class="btn btn-outline-secondary" :disabled="statusSaving" @click="closeDeleteConfirm">
                  취소
                </button>
                <button type="button" class="btn btn-danger"
                        :disabled="statusSaving || deleteConfirmText !== projectFolderName" @click="deleteProject">
                  <i class="bi bi-trash me-1"></i>최종 삭제
                </button>
              </div>
            </template>
          </template>
        </div>
      </div>

      <!-- 자율 ON/OFF 확인 다이얼로그 -->
      <div v-if="autonomyConfirm.open" class="modal-backdrop-custom" @click.self="closeAutonomyConfirm">
        <div class="card auto-modal p-4" role="dialog" aria-modal="true" aria-labelledby="paConfirmTitle">
          <h5 id="paConfirmTitle" class="mb-2">
            <i :class="autonomyConfirm.target ? 'bi bi-play-fill text-success' : 'bi bi-power text-danger'" class="me-2"></i>
            {{ autonomyConfirm.target ? '이 업무의 자율을 켤까요?' : '이 업무의 자율을 끌까요?' }}
          </h5>
          <p class="text-muted mb-4">
            <template v-if="autonomyConfirm.target">
              LEAD 가 심장박동마다 이 업무의 할 일을 스스로 판단해 배정합니다.
              목표와 관찰 LEAD 가 설정되어 있어야 켤 수 있습니다.
            </template>
            <template v-else>
              이 업무의 자율 배정이 멈춥니다. 진행 중 작업은 유지되지만 새 자동 배정은 생성되지 않습니다.
            </template>
          </p>
          <div class="d-flex justify-content-end gap-2">
            <button type="button" class="btn btn-outline-secondary" :disabled="autonomyToggling" @click="closeAutonomyConfirm">취소</button>
            <button type="button" ref="paConfirmBtn"
              class="btn" :class="autonomyConfirm.target ? 'btn-success' : 'btn-danger'"
              :disabled="autonomyToggling" @click="applyAutonomyToggle">
              <span v-if="autonomyToggling" class="spinner-border spinner-border-sm me-2"></span>
              {{ autonomyConfirm.target ? '켜기' : '끄기' }}
            </button>
          </div>
        </div>
      </div>

      <!-- ============ 파일 탭 ============ -->
      <div v-show="tab === 'files'">
        <div class="card p-4">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="h6 mb-0">파일 <span class="text-muted fw-normal">(프로젝트 폴더)</span></h2>
            <small v-if="filesAvailable && files.length" class="text-faint">{{ files.length }}개</small>
          </div>

          <nav v-if="filesAvailable" aria-label="breadcrumb" class="mb-2">
            <ol class="breadcrumb mb-0 small">
              <li class="breadcrumb-item"><a href="#" @click.prevent="openDir('')">루트</a></li>
              <li v-for="(seg, i) in pathSegments" :key="i" class="breadcrumb-item"
                :class="{ active: i === pathSegments.length - 1 }">
                <a v-if="i < pathSegments.length - 1" href="#" @click.prevent="openDir(seg.path)">{{ seg.name }}</a>
                <span v-else>{{ seg.name }}</span>
              </li>
            </ol>
          </nav>

          <div v-if="!filesAvailable" class="text-muted mb-0">
            프로젝트 폴더에 접근할 수 없습니다. <small>(경로 미설정 또는 로컬에 폴더 없음)</small>
          </div>
          <div v-else-if="filesLoading" class="text-muted mb-0">
            <span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...
          </div>
          <div v-else-if="!files.length" class="text-muted mb-0">표시할 파일이 없습니다.</div>
          <div v-else>
            <div v-for="f in files" :key="f.path"
              class="d-flex justify-content-between align-items-center py-2 border-bottom border-hairline">
              <div class="d-flex align-items-center gap-2 text-truncate">
                <i :class="fileIcon(f)"></i>
                <a v-if="f.is_dir" href="#" @click.prevent="openDir(f.path)" class="text-truncate">{{ f.name }}</a>
                <a v-else-if="f.viewable" href="#" @click.prevent="openFile(f)" class="text-truncate">{{ f.name }}</a>
                <span v-else class="text-truncate">{{ f.name }}</span>
                <button v-if="f.downloadable" @click="downloadFile(f)"
                  class="btn btn-sm btn-outline-primary py-0 px-2 flex-shrink-0"><i class="bi bi-download"></i></button>
              </div>
              <div class="d-flex align-items-center gap-3 flex-shrink-0">
                <small class="text-faint text-nowrap" v-if="!f.is_dir">{{ formatSize(f.size) }}</small>
                <small class="text-faint text-nowrap d-none d-sm-inline">{{ formatDate(f.updated_at) }}</small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="text-center py-5 text-muted">프로젝트를 불러오는 중...</div>

    <!-- 파일 미리보기 모달 -->
    <div v-if="viewFile" class="modal-backdrop-custom" @click.self="closeFile">
      <div class="modal-card card shadow">
        <div class="d-flex justify-content-between align-items-center p-3 border-bottom border-hairline">
          <div class="text-truncate">
            <i class="bi bi-file-earmark-text me-2"></i>
            <span class="fw-medium">{{ viewFile.name }}</span>
            <small class="text-faint ms-2">{{ formatSize(viewFile.size) }}</small>
          </div>
          <div class="d-flex align-items-center gap-2 flex-shrink-0">
            <button v-if="viewFile.downloadable" @click="downloadFile(viewFile)"
              class="btn btn-sm btn-outline-secondary py-0 px-2"><i class="bi bi-download"></i></button>
            <button class="btn-close" @click="closeFile" aria-label="닫기"></button>
          </div>
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
/* 공통 .pd-stat/.pd-progress/.pd-list/.pd-item/.pd-dot/.pd-subseg, .min-w-0 은 base.css 로 승격(2026-06-24). 여기엔 상세 전용(탭·상태셀렉트·모달)만 둔다. */

/* ===== 프로젝트 상세 탭 (underline 강조형) ===== */
/* 회색 페이지 위에 균일한 흰 띠로. (배경이 투명하면 양끝 흰색 스크롤 커버와 색이 어긋나 흰 박스처럼 보임) */
.pd-tabs-wrap { display: flex; align-items: flex-end; border-bottom: 1px solid var(--color-hairline); background-color: var(--color-surface); border-radius: var(--rounded-md) var(--rounded-md) 0 0; margin-bottom: 1.5rem; }
.pd-tabs { border-bottom: none; gap: 0.125rem; background-color: transparent; border-radius: 0; flex: 1; min-width: 0; }
.pd-tabs .nav-link {
  position: relative; display: inline-flex; align-items: center; gap: 0.4rem;
  color: var(--color-ink-muted); font-size: 0.9375rem; font-weight: 500;
  border: none; background: none; border-radius: var(--rounded-sm) var(--rounded-sm) 0 0;
  padding: 0.625rem 0.875rem; margin-bottom: -1px;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.pd-tabs .nav-link::after {
  content: ""; position: absolute; left: 0.5rem; right: 0.5rem; bottom: -1px;
  height: 2px; border-radius: 2px 2px 0 0; background-color: var(--color-primary);
  transform: scaleX(0); transform-origin: center; transition: transform 0.2s ease;
}
.pd-tabs .nav-link:hover { color: var(--color-ink); background-color: var(--color-canvas-soft); }
.pd-tabs .nav-link:hover::after { transform: scaleX(0.4); background-color: var(--color-hairline); }
.pd-tabs .nav-link.active { color: var(--color-primary); font-weight: 600; background: none; }
.pd-tabs .nav-link.active::after { transform: scaleX(1); background-color: var(--color-primary); }
.pd-tabs .nav-link:focus-visible { outline: 2px solid rgba(0,117,222,0.4); outline-offset: -2px; border-radius: var(--rounded-sm); }
.pd-tab-icon { font-size: 1rem; opacity: 0.85; }
.pd-tab-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.25rem; height: 1.25rem; padding: 0 0.375rem;
  font-size: 0.6875rem; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--color-ink-muted); background-color: var(--color-canvas-soft);
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-full);
}
.pd-tab-count--alert { color: #c12c39; background-color: rgba(220,53,69,0.12); border-color: rgba(220,53,69,0.2); }
.pd-tabs .nav-link.active .pd-tab-count { color: var(--color-primary); background-color: rgba(0,117,222,0.1); border-color: rgba(0,117,222,0.2); }
@media (max-width: 575.98px) {
  .pd-tabs .nav-link { padding: 0.625rem 0.625rem; font-size: 0.875rem; }
  .pd-tab-icon { font-size: 0.9375rem; }
}

/* 상세 전용: 라이프사이클 상태 셀렉트 */
.pd-status-select { width: auto; min-width: 6rem; }
.spin { display: inline-block; animation: ai-spin 0.8s linear infinite; }

/* 상세 헤더 설명: 최대 2줄까지만 노출 */
.pd-desc-clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

@media (prefers-reduced-motion: reduce) {
  .pd-tabs .nav-link::after { transition: none; }
}

/* ===== 현재 상태 (STATUS.md) 카드 ===== */
.pd-status-card { border-left: 3px solid var(--color-primary); }
.status-md-wrap { position: relative; }
.status-md { font-size: .875rem; line-height: 1.6; color: var(--color-ink); }
.status-md-collapsed { max-height: 220px; overflow: hidden; }
.status-md-fade {
  position: absolute; bottom: 0; left: 0; right: 0; height: 3.5rem;
  background: linear-gradient(transparent, var(--color-canvas));
  pointer-events: none;
}
.status-md h1, .status-md h2, .status-md h3, .status-md h4, .status-md h5, .status-md h6 {
  font-size: .9375rem; font-weight: 600; margin: .75rem 0 .375rem;
}
.status-md h1:first-child, .status-md h2:first-child { margin-top: 0; }
.status-md p { margin: 0 0 .5rem; }
.status-md ul, .status-md ol { margin: 0 0 .5rem; padding-left: 1.25rem; }
.status-md li { margin-bottom: .2rem; }
.status-md hr { margin: .75rem 0; border: 0; border-top: 1px solid var(--color-hairline); }
.status-md blockquote {
  margin: 0 0 .5rem; padding: .25rem .75rem; color: var(--color-ink-muted);
  border-left: 2px solid var(--color-hairline); background: var(--color-canvas-soft);
}
.status-md code {
  font-size: .8125rem; padding: .1em .35em; border-radius: var(--rounded-sm);
  background: var(--color-canvas-soft);
}
.status-md pre.md-code {
  margin: 0 0 .5rem; padding: .625rem .75rem; overflow-x: auto;
  background: var(--color-canvas-soft); border-radius: var(--rounded-sm);
}
.status-md pre.md-code code { background: none; padding: 0; }

/* ===== 파일 미리보기 모달 ===== */
.modal-backdrop-custom { position: fixed; inset: 0; z-index: 1050; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; padding: 1rem; }
.modal-backdrop-custom .modal-card, .modal-backdrop-custom .auto-modal { width: 100%; max-width: 900px; max-height: 85vh; display: flex; flex-direction: column; }
.modal-backdrop-custom .auto-modal { max-width: 30rem; }
.modal-backdrop-custom .modal-body-scroll { overflow: auto; }
.file-preview { white-space: pre-wrap; word-break: break-word; font-size: .8125rem; line-height: 1.5; padding: 1rem 1.25rem; }
.context-scroll { max-height: 360px; overflow-y: auto; }

/* ===== 통합 타임라인 ===== */
.act-cat-badge { display: inline-flex; align-items: center; gap: 0.2rem; }
.tl-source-tag {
  font-size: 0.7rem; font-weight: 600; color: var(--color-ink-muted);
  background: var(--color-canvas-soft); border-radius: var(--rounded-sm); padding: 0.05rem 0.35rem;
}
.tl-target {
  font-size: 0.72rem; color: var(--color-ink-muted); background: var(--color-canvas-soft);
  padding: 0.05rem 0.35rem; border-radius: var(--rounded-sm); word-break: break-all;
}
/* correlation_id 로 묶인 후속 이벤트는 살짝 들여쓰기 + 좌측 라인으로 그룹 표현 */
.tl-grouped { margin-left: 1.25rem; border-left: 2px solid var(--color-hairline); padding-left: 0.75rem; }

/* ===== 자율 탭 ===== */
.pd-auto-dot {
  display: inline-block; width: 0.5rem; height: 0.5rem; margin-left: 0.375rem;
  border-radius: 50%; background: var(--color-accent-green, #1aae39); vertical-align: middle;
}
.pa-switch { border-width: 1px; transition: border-color 0.2s, background-color 0.2s; }
.pa-switch--on { border-left: 4px solid var(--color-accent-green, #1aae39); background: rgba(26,174,57,0.04); }
.pa-switch--off { border-left: 4px solid var(--color-ink-faint, #adb5bd); }
.pa-switch-icon { font-size: 2.25rem; line-height: 1; flex-shrink: 0; }
.pa-switch-state { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02rem; }
.text-ink-muted { color: var(--color-ink-muted); }
.pa-switch-btn { min-width: 9rem; font-weight: 600; }
@media (max-width: 575.98px) {
  .pa-switch-btn { width: 100%; }
  .pa-switch-state { font-size: 1.125rem; }
}
</style>

<script>
export default {
  title: '프로젝트 상세',
  data() {
    return {
      tab: 'now',
      loaded: {},
      project: null,
      summary: null,
      statusMd: '',
      statusUpdatedAt: '',
      tasks: [],
      activities: [],
      sessions: [],
      commands: [],
      // 통합 타임라인 (activity + session + command + task 4원천)
      timeline: [],
      timelineLoading: false,
      timelineError: '',
      timelineCounts: null,
      timelineSourcesFailed: [],
      timelineIncludeTelemetry: false,
      timelineHasMore: false,
      timelineLoadingMore: false,
      decisions: [],
      issues: [],
      memories: [],
      agents: [],
      files: [],
      filePath: '',
      filesAvailable: true,
      filesLoading: true,
      viewFile: null,
      fileLoading: false,
      fileError: '',
      // 업무지시
      assignMode: 'task',
      newTask: { title: '', agent_name: '', description: '' },
      submittingTask: false,
      taskError: '',
      assignNotice: '',
      newCommand: '',
      submittingCommand: false,
      commandError: '',
      // 진행상황
      journalRefreshing: false,
      progressSeg: 'timeline',
      progressSegs: [
        { key: 'timeline', label: '통합' },
        { key: 'commands', label: '명령' },
        { key: 'activities', label: '활동' },
        { key: 'sessions', label: '세션' },
        { key: 'decisions', label: '결정' },
        { key: 'issues', label: '이슈' },
        { key: 'memories', label: '메모리' }
      ],
      // AI 기록
      issueOpenOnly: true,
      // 자율 설정
      autonomy: null,
      autonomyForm: { goal: '', custom_instruction: '', kpiRows: [], lead_agent_name: null, cadence: 'daily', risk_approval_threshold: 'high', kpi_complete_action: 'continue' },
      kpiCodeSuggestions: ['응답시간', '가동률', '오류율', '처리건수', '완료율', '미해결이슈', '재작업률', '방문자수', '전환율', '매출', '고객만족도', '리드타임'],
      kpiUnitSuggestions: ['%', 'ms', '건', '원', '명', '회', '점', '일'],
      globalAutonomyEnabled: false,
      autonomyLoading: false,
      autonomySaving: false,
      autonomyToggling: false,
      autonomyError: '',
      autonomyNotice: '',
      autonomyConfirm: { open: false, target: false },
      statusSaving: false,
      statusError: '',
      statusExpanded: false,
      deleteConfirmOpen: false,
      deleteConfirmText: '',
      // 모니터링 탭 (이 프로젝트로 스코핑된 실시간 실행 모니터, 폴링 방식)
      monitorActive: [],
      monitorRecent: [],
      monitorLog: [],
      monitorSse: null,
      monitorTick: 0,
      monitorTimer: null,
      monitorCursors: {},
      terminatingId: null,
      retryingId: null,
    }
  },
  computed: {
    // 자율 탭을 아직 열지 않았어도(목록 로드 시 함께 온 project.autonomy_active) 헤더/탭 표시가 즉시 정확하도록,
    // 탭을 열어 최신 effective 값(autonomy.autonomy_enabled)이 로드되면 그쪽을 우선한다.
    isAutonomyActive() {
      if (this.autonomy) return !!this.autonomy.autonomy_enabled
      return !!(this.project && this.project.autonomy_active)
    },
    // 삭제 확인용 폴더명 — project.path 의 마지막 세그먼트, 없으면 프로젝트명으로 대체.
    projectFolderName() {
      if (!this.project) return ''
      const segs = (this.project.path || '').split('/').filter(Boolean)
      return segs.length ? segs[segs.length - 1] : this.project.name
    },
    openIssueCount() { return this.issues.filter(i => i.status === 'open').length },
    journalBadge() {
      // issues.open은 summary에서 초기에 반영(lazy load 전), 상세로드 후엔 실제 배열 우선
      const issueCount = this.issues.length ? this.openIssueCount : (this.summary?.issues?.open || 0)
      if (issueCount) return { val: issueCount, alert: true }
      if (this.activeTaskCount) return { val: this.activeTaskCount, alert: false }
      return { val: 0, alert: false }
    },
    openIssues() { return this.issues.filter(i => i.status === 'open') },
    filteredIssues() { return this.issueOpenOnly ? this.issues.filter(i => i.status === 'open') : this.issues },
    activeTaskCount() { return this.tasks.filter(t => t.status === 'in_progress' || t.status === 'pending').length },
    pathSegments() {
      if (!this.filePath) return []
      const parts = this.filePath.split('/').filter(Boolean)
      let acc = ''
      return parts.map(name => { acc = acc ? acc + '/' + name : name; return { name, path: acc } })
    },
    // correlation_id 로 묶인 후속(연속) 이벤트를 그룹 들여쓰기 표시하기 위한 주석 배열.
    timelineRows() {
      let prevCorr = null
      return this.timeline.map(ev => {
        const corr = (ev.meta && ev.meta.correlation_id) || null
        const grouped = !!corr && corr === prevCorr
        prevCorr = corr
        return Object.assign({}, ev, { _grouped: grouped })
      })
    }
  },
  async mounted() {
    const id = this.$route.params.id
    // 개요 진입: 프로젝트 메타 + summary + 개요에 쓰는 활동/이슈를 먼저.
    const [pRes, sumRes, aRes, isRes] = await Promise.all([
      useApi('/api/projects/' + id),
      useApi('/api/projects/' + id + '/summary'),
      useApi('/api/activities?project_id=' + id),
      useApi('/api/context/issues?project_id=' + id)
    ])
    if (pRes.data) this.project = pRes.data.project
    if (sumRes.data) this.summary = sumRes.data.summary
    if (aRes.data) this.activities = aRes.data.activities || []
    if (isRes.data) this.issues = isRes.data.issues || []
    this.loaded.overview = true
    // STATUS.md(프로젝트 진행 상태 단일 소스)를 개요 최상단에 표시. 없으면 조용히 숨김.
    this.loadStatus()
    // 탭별 데이터는 첫 진입 시 lazy 로드. 단 진행상황 배지(작업수)를 위해 tasks 는 미리.
    this.loadTasks()
    // 개요 "최근 활동"·진행상황 "통합" 세그먼트가 공유하는 통합 타임라인.
    this.loadTimeline()
    // ?tab= 딥링크 지원 (하위 호환: 옛 키는 새 키로 리다이렉트)
    const q = this.$route.query.tab
    const tabAliases = { overview: 'now', status: 'now', assign: 'instruct', progress: 'journal', context: 'journal', autonomy: 'settings' }
    const validTabs = ['now', 'instruct', 'monitor', 'journal', 'files', 'settings']
    if (q) {
      const resolved = tabAliases[q] || (validTabs.includes(q) ? q : null)
      if (resolved) this.selectTab(resolved)
    }
  },
  unmounted() {
    this.disconnectMonitor()
  },
  methods: {
    selectTab(t) {
      const prev = this.tab
      this.tab = t
      if (this.$route.query.tab !== t) {
        this.$router.replace({ query: { ...this.$route.query, tab: t } }).catch(() => {})
      }
      this.scrollActiveTabIntoView()
      if (prev === 'monitor' && t !== 'monitor') this.disconnectMonitor()
      if (t === 'monitor') { this.connectMonitor(); return }
      if (this.loaded[t]) return
      this.loaded[t] = true
      if (t === 'instruct') this.loadAgents()
      else if (t === 'journal') { this.loadCommands(); this.loadSessions() }
      else if (t === 'files') this.loadFiles('')
      else if (t === 'settings') this.loadAutonomy()
    },
    // 모바일 가로스크롤 탭바: 활성 탭이 화면 밖이면 보이도록 스크롤(잘림 방지).
    scrollActiveTabIntoView() {
      this.$nextTick(() => {
        const bar = this.$refs.tabbar
        if (!bar) return
        const active = bar.querySelector('.nav-link.active')
        if (active && active.scrollIntoView) {
          active.scrollIntoView({ inline: 'nearest', block: 'nearest' })
        }
      })
    },
    // 지금 탭 → 기록 탭의 특정 세그먼트로 바로 진입.
    goProgress(seg) {
      if (seg) this.progressSeg = seg
      this.selectTab('journal')
    },
    // 기록 탭 서브탭 버튼 클릭 처리. decisions/issues/memories 선택 시 context lazy load.
    onProgressSegClick(key) {
      this.progressSeg = key
      if (['decisions', 'issues', 'memories'].includes(key) && !this.loaded.context) {
        this.loaded.context = true
        this.loadContext()
      }
    },
    // 기록 탭 새로고침 — 현재 서브탭에 맞는 데이터만 다시 로드.
    async refreshJournal() {
      this.journalRefreshing = true
      try {
        const seg = this.progressSeg
        if (seg === 'timeline') await this.loadTimeline()
        else if (seg === 'commands') await this.loadCommands()
        else if (seg === 'activities') {
          const id = this.$route.params.id
          const { data } = await useApi('/api/activities?project_id=' + id)
          if (data) this.activities = data.activities || []
        }
        else if (seg === 'sessions') await this.loadSessions()
        else if (['decisions', 'issues', 'memories'].includes(seg)) await this.loadContext()
      } finally {
        this.journalRefreshing = false
      }
    },
    // STATUS.md 읽기. 프로젝트 루트의 진행 상태 단일 소스. 파일 미리보기 엔드포인트 재사용.
    async loadStatus() {
      const id = this.$route.params.id
      const { data } = await useApi('/api/projects/' + id + '/file?file=STATUS.md')
      if (data && data.content) {
        this.statusMd = data.content
        this.statusUpdatedAt = data.updated_at || ''
      }
    },
    renderStatus() { return renderMarkdown(this.statusMd) },
    async loadTasks() {
      const id = this.$route.params.id
      const { data } = await useApi('/api/commands?project_id=' + id)
      if (data) this.tasks = (data.commands || []).map(this.commandToTaskShape)
    },
    // commands(8상태) → "작업" 탭 표시용 축약 4상태(예전 tasks 테이블 API 계약과 동일한 표시 형태).
    commandToTaskShape(cmd) {
      const STATUS_MAP = {
        queued: 'pending', approved: 'pending', claimed: 'in_progress',
        running: 'in_progress', done: 'completed',
        failed: 'failed', rejected: 'failed', expired: 'failed'
      }
      return {
        id: cmd.id,
        title: cmd.title || (cmd.instruction ? String(cmd.instruction).slice(0, 120) : '(작업)'),
        agent_name: cmd.assignee_agent_name || null,
        status: STATUS_MAP[cmd.status] || 'pending',
        created_at: cmd.created_at || null
      }
    },
    async loadAgents() {
      const { data } = await useApi('/api/agents')
      if (data) this.agents = data.agents || []
    },
    async loadCommands() {
      const id = this.$route.params.id
      const { data, error } = await useApi('/api/commands?project_id=' + id)
      if (data) { this.commands = data.commands || []; this.commandError = '' }
      else {
        this.commandError = error && error.includes('401')
          ? '명령 이력을 보려면 로그인이 필요합니다.'
          : ('명령 이력을 불러오지 못했습니다: ' + (error || '알 수 없는 오류'))
      }
    },
    async loadSessions() {
      const id = this.$route.params.id
      const { data } = await useApi('/api/projects/' + id + '/sessions')
      if (data) this.sessions = data.sessions || []
    },
    // ===== 통합 타임라인 (activity + session + command + task) =====
    async loadTimeline() {
      this.timelineLoading = true
      this.timelineError = ''
      const id = this.$route.params.id
      const p = new URLSearchParams()
      p.set('limit', '50')
      if (this.timelineIncludeTelemetry) p.set('include_telemetry', '1')
      const { data, error } = await useApi('/api/projects/' + id + '/timeline?' + p.toString())
      this.timelineLoading = false
      if (error || !data) {
        this.timelineError = error && error.includes('401')
          ? '타임라인을 보려면 로그인이 필요합니다.'
          : ('타임라인을 불러오지 못했습니다: ' + (error || '알 수 없는 오류'))
        return
      }
      this.timeline = data.timeline || []
      this.timelineCounts = data.counts || null
      this.timelineSourcesFailed = data.sources_failed || []
      this.timelineHasMore = this.timeline.length >= 50
    },
    async loadMoreTimeline() {
      if (!this.timeline.length) return
      this.timelineLoadingMore = true
      const id = this.$route.params.id
      const last = this.timeline[this.timeline.length - 1]
      const p = new URLSearchParams()
      p.set('limit', '50')
      p.set('before', last.ts)
      if (this.timelineIncludeTelemetry) p.set('include_telemetry', '1')
      const { data, error } = await useApi('/api/projects/' + id + '/timeline?' + p.toString())
      this.timelineLoadingMore = false
      if (error || !data) return
      const more = data.timeline || []
      this.timeline = this.timeline.concat(more)
      this.timelineHasMore = more.length >= 50
    },
    sourceMeta(s) {
      const m = {
        activity: { label: '활동', icon: 'bi-activity', color: 'info' },
        session: { label: '대화', icon: 'bi-chat-dots', color: 'primary' },
        command: { label: '터미널', icon: 'bi-terminal', color: 'secondary' },
        task: { label: '체크리스트', icon: 'bi-list-check', color: 'success' }
      }
      return m[s] || { label: s || '기타', icon: 'bi-dot', color: 'secondary' }
    },
    catMeta(c) { return activityCategoryMeta(c) },
    resMeta(r) { return activityResultMeta(r) },
    async loadContext() {
      const id = this.$route.params.id
      const [dcRes, mmRes] = await Promise.all([
        useApi('/api/context/decisions?project_id=' + id),
        useApi('/api/context/memories?project_id=' + id)
      ])
      if (dcRes.data) this.decisions = dcRes.data.decisions || []
      if (mmRes.data) this.memories = mmRes.data.memories || []
      // 이슈는 mounted 에서 이미 로드됨.
    },
    // ===== 자율 설정 =====
    async loadAutonomy() {
      this.autonomyLoading = true
      this.autonomyError = ''
      const id = this.$route.params.id
      // 설정 + 에이전트(LEAD 후보) + 전역 마스터 스위치를 함께.
      const [aRes, agRes, gRes] = await Promise.all([
        useApi('/api/projects/' + id + '/autonomy'),
        this.agents.length ? Promise.resolve({ data: { agents: this.agents } }) : useApi('/api/agents'),
        useApi('/api/lead/autonomy')
      ])
      this.autonomyLoading = false
      if (agRes.data) this.agents = agRes.data.agents || this.agents
      if (gRes.data) this.globalAutonomyEnabled = !!gRes.data.enabled
      if (aRes.error || !aRes.data) {
        this.autonomyError = aRes.error && aRes.error.includes('401')
          ? '자율 설정을 보려면 로그인이 필요합니다.'
          : ('자율 설정을 불러오지 못했습니다: ' + (aRes.error || '알 수 없는 오류'))
        return
      }
      this.autonomy = aRes.data.autonomy
      this.resetAutonomyForm()
    },
    // kpi_json(문자열|객체) → 편집용 행 배열로.
    kpiJsonToRows(raw) {
      if (!raw) return []
      let obj
      try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
      if (!obj || typeof obj !== 'object') return []
      return Object.entries(obj).map(([code, v]) => ({
        code,
        target: (v && typeof v === 'object' && v.target != null) ? String(v.target) : (typeof v !== 'object' ? String(v) : ''),
        unit: (v && typeof v === 'object' && v.unit) ? String(v.unit) : ''
      }))
    },
    // 편집 행 → kpi_json 객체. 지표명 없는 행은 버림. 전부 비면 null.
    rowsToKpiJson(rows) {
      const obj = {}
      for (const r of rows) {
        const code = (r.code || '').trim()
        if (!code) continue
        const target = (r.target || '').trim()
        const unit = (r.unit || '').trim()
        obj[code] = unit ? { target, unit } : { target }
      }
      return Object.keys(obj).length ? obj : null
    },
    resetAutonomyForm() {
      if (!this.autonomy) return
      this.autonomyForm = {
        goal: this.autonomy.goal || '',
        custom_instruction: this.autonomy.custom_instruction || '',
        kpiRows: this.kpiJsonToRows(this.autonomy.kpi_json),
        lead_agent_name: this.autonomy.lead_agent_name || null,
        cadence: this.autonomy.cadence || 'daily',
        // 백엔드 의미론(autonomy.js riskAllowsAuto): null/undefined 는 'off'(risk-blind)와 동치.
        //   'high'로 폴백하면 실제=무방비인데 화면엔 "high 이상 승인 필요"로 보이는 표시-실제
        //   불일치가 생긴다(reviewer M1) — 백엔드와 동일한 폴백 방향(off)으로 맞춘다.
        risk_approval_threshold: this.autonomy.risk_approval_threshold ?? 'off',
        kpi_complete_action: this.autonomy.kpi_complete_action || 'continue'
      }
      this.autonomyError = ''
    },
    addKpiRow() { this.autonomyForm.kpiRows.push({ code: '', target: '', unit: '' }) },
    removeKpiRow(idx) { this.autonomyForm.kpiRows.splice(idx, 1) },
    // 설정 저장. wantEnable=true 면 자율 ON 도 함께 요청(토글 확인에서 호출).
    // 라이프사이클 상태 변경(대기/진행/완료/보류) — 운영자 명시적 전환. PUT /:id/status(JWT).
    async changeStatus(newStatus) {
      if (!this.project || newStatus === this.project.status) return
      const prev = this.project.status
      this.statusSaving = true
      this.statusError = ''
      const { data, error } = await useApi('/api/projects/' + this.$route.params.id + '/status', {
        method: 'PUT', body: { status: newStatus }
      })
      this.statusSaving = false
      if (error) {
        // 저장 실패 시 select 를 원상복구(project.status 는 안 바꿨으므로 :value 바인딩이 되돌림).
        this.statusError = String(error).includes('401')
          ? '상태를 변경하려면 로그인이 필요합니다.'
          : '상태 변경 실패: ' + error
        this.$forceUpdate()
        return
      }
      if (data && data.project) {
        // 서버가 파생필드(activity_status)까지 실어 돌려주므로 통째 반영.
        this.project = { ...this.project, ...data.project }
      } else {
        this.project.status = newStatus
      }
      if (prev !== this.project.status) this.statusError = ''
    },
    openDeleteConfirm() {
      this.deleteConfirmOpen = true
      this.deleteConfirmText = ''
      this.$nextTick(() => this.$refs.deleteConfirmInput && this.$refs.deleteConfirmInput.focus())
    },
    closeDeleteConfirm() {
      this.deleteConfirmOpen = false
      this.deleteConfirmText = ''
    },
    async deleteProject() {
      if (!this.project || this.deleteConfirmText !== this.projectFolderName) return
      await this.changeStatus('deleted')
      this.closeDeleteConfirm()
      if (this.project.status === 'deleted') this.$router.push('/projects')
    },
    async restoreProject() {
      await this.changeStatus('pending')
    },
    async saveAutonomy(wantEnable) {
      this.autonomySaving = true
      this.autonomyError = ''
      this.autonomyNotice = ''
      const body = {
        goal: this.autonomyForm.goal.trim() || null,
        custom_instruction: this.autonomyForm.custom_instruction.trim() || null,
        kpi_json: this.rowsToKpiJson(this.autonomyForm.kpiRows),
        lead_agent_name: this.autonomyForm.lead_agent_name || null,
        cadence: this.autonomyForm.cadence,
        risk_approval_threshold: this.autonomyForm.risk_approval_threshold,
        kpi_complete_action: this.autonomyForm.kpi_complete_action
      }
      if (wantEnable === true) body.autonomy_enabled = true
      else if (wantEnable === false) body.autonomy_enabled = false
      const { data, error } = await useApi('/api/projects/' + this.$route.params.id + '/autonomy', {
        method: 'PUT', body
      })
      this.autonomySaving = false
      if (error) {
        // 400(LEAD 없이 ON 시도 등)을 사용자 친화 메시지로.
        this.autonomyError = this.humanizeAutonomyError(error)
        return false
      }
      if (data && data.autonomy) {
        this.autonomy = data.autonomy
        if (this.project) this.project.autonomy_active = data.autonomy.autonomy_enabled
        this.resetAutonomyForm()
        this.autonomyNotice = '자율 설정을 저장했습니다.'
      }
      return true
    },
    humanizeAutonomyError(error) {
      const e = String(error || '')
      if (e.includes('requires a lead_agent_name')) return '자율을 켜려면 관찰 LEAD 를 먼저 지정하세요.'
      if (e.includes('is not a registered agent')) return '선택한 LEAD 가 등록된 에이전트가 아닙니다.'
      if (e.includes('kpi_json')) return 'KPI 형식이 올바르지 않습니다. 지표명과 목표값을 확인하세요.'
      if (e.includes('cadence')) return '박동 주기 값이 올바르지 않습니다.'
      if (e.includes('risk_approval_threshold')) return '위험도 승인 임계값이 올바르지 않습니다.'
      if (e.includes('401')) return '설정을 저장하려면 로그인이 필요합니다.'
      return '자율 설정 저장 실패: ' + e
    },
    openAutonomyConfirm(target) {
      // 켜려는데 목표/LEAD 가 폼에 없으면 확인 없이 즉시 안내(측정가능 목표 + LEAD 필수).
      if (target) {
        if (!this.autonomyForm.goal.trim()) {
          this.autonomyError = '자율을 켜려면 측정 가능한 목표를 먼저 입력·저장하세요.'
          return
        }
        if (!this.autonomyForm.lead_agent_name) {
          this.autonomyError = '자율을 켜려면 관찰 LEAD 를 먼저 지정·저장하세요.'
          return
        }
      }
      this.autonomyError = ''
      this.autonomyConfirm = { open: true, target }
      this.$nextTick(() => { this.$refs.paConfirmBtn?.focus() })
    },
    closeAutonomyConfirm() {
      if (this.autonomyToggling) return
      this.autonomyConfirm.open = false
    },
    async applyAutonomyToggle() {
      const target = this.autonomyConfirm.target
      this.autonomyToggling = true
      // 현재 폼 설정과 함께 on/off 를 보낸다(목표·LEAD 저장 누락 방지).
      const ok = await this.saveAutonomy(target)
      this.autonomyToggling = false
      this.autonomyConfirm.open = false
      if (ok) this.autonomyNotice = target ? '이 업무의 자율을 켰습니다.' : '이 업무의 자율을 껐습니다.'
    },
    async submitTask() {
      const title = this.newTask.title.trim()
      if (!title || this.submittingTask) return
      this.submittingTask = true
      this.taskError = ''
      const description = this.newTask.description.trim()
      const { data, error } = await useApi('/api/commands', {
        method: 'POST',
        // (2026-07-14 대표 지시) 프로젝트 상세 "작업 카드 만들기"는 승인함을 거치지 않고
        //   direct:true 자가승인(approved)으로 곧바로 실행 큐에 올린다. "로컬에 직접 명령"과
        //   동일한 §3-1 자가승인 경로를 재사용(콘솔·자율엔진 cycle 등 다른 생성 경로는 불변).
        body: {
          project_id: this.$route.params.id,
          instruction: description || title,
          title,
          assignee_agent_name: this.newTask.agent_name || null,
          direct: true
        }
      })
      this.submittingTask = false
      if (error) {
        this.taskError = error.includes('401') ? '작업을 만들려면 로그인이 필요합니다.' : ('작업 생성 실패: ' + error)
        return
      }
      if (data && data.command) {
        const task = this.commandToTaskShape(data.command)
        this.tasks.unshift(task)
        this.assignNotice = '"' + task.title + '" 작업이 생성됐습니다.'
        this.newTask = { title: '', agent_name: '', description: '' }
        this.refreshSummary()
      }
    },
    async refreshSummary() {
      const { data } = await useApi('/api/projects/' + this.$route.params.id + '/summary')
      if (data) this.summary = data.summary
    },
    async loadFiles(path) {
      this.filesLoading = true
      const id = this.$route.params.id
      const qs = path ? '?path=' + encodeURIComponent(path) : ''
      const { data, error } = await useApi('/api/projects/' + id + '/files' + qs)
      this.filesLoading = false
      if (error || !data) { this.filesAvailable = false; return }
      this.filesAvailable = data.available !== false
      this.filePath = data.path || ''
      this.files = data.entries || []
    },
    openDir(path) { this.loadFiles(path) },
    async openFile(f) {
      this.viewFile = { name: f.name, path: f.path, size: f.size, downloadable: f.downloadable, content: '' }
      this.fileLoading = true
      this.fileError = ''
      const id = this.$route.params.id
      const { data, error } = await useApi('/api/projects/' + id + '/file?file=' + encodeURIComponent(f.path))
      this.fileLoading = false
      if (error || !data) { this.fileError = '파일을 읽지 못했습니다: ' + (error || '알 수 없는 오류'); return }
      this.viewFile.content = data.content
    },
    closeFile() { this.viewFile = null; this.fileError = '' },
    issueColor(i) {
      if (i.status !== 'open') return 'success'
      return { critical: 'danger', high: 'danger', medium: 'warning', low: 'secondary' }[i.severity] || 'warning'
    },
    async downloadFile(f) {
      // <a download> 직접 링크는 Authorization 헤더가 안 실려 터널 경유 시 401 JSON 이
      // 다운로드된다. 토큰을 헤더에 실어 fetch→blob 으로 저장한다.
      const url = '/api/projects/' + this.$route.params.id + '/download?file=' + encodeURIComponent(f.path)
      const r = await downloadFileAuth(url, f.name)
      if (!r.ok) alert('다운로드 실패: ' + r.error)
    },
    fileIcon(f) {
      if (f.is_dir) return 'bi bi-folder-fill text-warning'
      const ext = (f.name.split('.').pop() || '').toLowerCase()
      const map = { zip: 'bi-file-zip', pptx: 'bi-file-earmark-ppt', ppt: 'bi-file-earmark-ppt',
        pdf: 'bi-file-earmark-pdf', md: 'bi-file-earmark-text', js: 'bi-filetype-js',
        json: 'bi-filetype-json', vue: 'bi-file-earmark-code', png: 'bi-file-earmark-image',
        jpg: 'bi-file-earmark-image', jpeg: 'bi-file-earmark-image' }
      return 'bi ' + (map[ext] || 'bi-file-earmark') + ' text-muted'
    },
    formatSize(bytes) {
      if (bytes === null || bytes === undefined) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
      return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
    },
    async submitCommand() {
      const instruction = this.newCommand.trim()
      if (!instruction || this.submittingCommand) return
      this.submittingCommand = true
      this.commandError = ''
      const { data, error } = await useApi('/api/commands', {
        method: 'POST',
        // (통합 실행모델 §3-1) "로컬에 직접 명령" = 즉시 실행 의도 → direct:true 자가승인(approved).
        //   승인함(작업 카드)을 거치지 않고 곧바로 실행 경로(즉시디스패치/안전망 poll)에 올린다.
        body: { instruction, project_id: this.$route.params.id, direct: true }
      })
      this.submittingCommand = false
      if (error) {
        this.commandError = error.includes('401') ? '명령을 보내려면 로그인이 필요합니다.' : ('명령 전송 실패: ' + error)
        return
      }
      if (data && data.command) {
        this.commands.unshift(data.command)
        this.assignNotice = '명령이 즉시 실행 큐에 올라갔습니다(자가승인).'
        this.newCommand = ''
        this.refreshSummary()
      }
    },
    isCommandFinished(s) { return ['done', 'failed', 'rejected', 'expired'].includes(s) },
    commandStatusColor(s) {
      return { queued: 'secondary', approved: 'info', claimed: 'info', running: 'primary',
        done: 'success', failed: 'danger', rejected: 'danger', expired: 'secondary' }[s] || 'secondary'
    },
    commandStatusLabel(s) {
      return { queued: '대기', approved: '승인됨', claimed: '점유', running: '실행중',
        done: '완료', failed: '실패', rejected: '거부', expired: '만료' }[s] || s
    },
    statusColor(s) { return { pending: 'secondary', active: 'primary', completed: 'success', on_hold: 'warning', deleted: 'danger' }[s] || 'secondary' },
    statusLabel(s) { return { pending: '대기', active: '진행', completed: '완료', on_hold: '보류', deleted: '삭제됨' }[s] || s },
    // 가동 상태(서버 파생 activity_status) — "지금 실제로 돌고 있나". 라이프사이클과 직교.
    activityLabel() { return { running: '가동 중', idle: '대기', stalled: '점검필요', off: '정지' }[this.project.activity_status] || '정지' },
    activityBadge() { return { running: 'bg-success', idle: 'bg-primary', stalled: 'bg-warning', off: 'bg-secondary' }[this.project.activity_status] || 'bg-secondary' },
    activityIcon() { return { running: 'bi-broadcast', idle: 'bi-hourglass-split', stalled: 'bi-exclamation-triangle', off: 'bi-pause-circle' }[this.project.activity_status] || 'bi-pause-circle' },
    formatDate(iso) {
      if (!iso) return ''
      return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    },
    formatDateTime(iso) {
      if (!iso) return ''
      return new Date(iso).toLocaleString('ko-KR', { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    },
    // 모니터링 탭 — 초단위 폴링으로 이 프로젝트만 스코핑해 조회.
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
    // 2026-07-14: 목록/상태의 권위 소스를 인메모리 execMonitor에서 commands 테이블(DB) 폴링으로 교체
    //   (activities.vue 전역 모니터 탭과 동일 패턴). 로그 테일만 기존 execMonitor 경유(/api/monitor/log)
    //   보조 유지 — 비어도 상태 표시는 DB 값으로 계속 정상 동작.
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
      const token = localStorage.getItem('token')
      const pid = this.$route.params.id
      const [activeRes, recentRes] = await Promise.all([
        useApi(`/api/commands?project_id=${pid}&status=claimed,running&limit=20`),
        useApi(`/api/commands?project_id=${pid}&status=done,failed&limit=20`),
      ])
      if (activeRes.data) this.monitorActive = (activeRes.data.commands || []).map(this.mapCommandToRun)
      if (recentRes.data) this.monitorRecent = (recentRes.data.commands || []).map(this.mapCommandToRun)
      for (const run of (this.monitorActive || [])) {
        const since = this.monitorCursors[run.id] ?? 0
        const logQs = new URLSearchParams({ since: String(since) })
        if (token) logQs.set('token', token)
        const r = await useApi(`/api/monitor/log/${run.id}?${logQs.toString()}`)
        if (!r.data) continue
        const { entries, total } = r.data
        this.monitorCursors[run.id] = total
        for (const entry of (entries || [])) {
          if (entry.kind === 'stderr') {
            this.pushMonitorLog({ kind: 'stderr', text: entry.text, ts: entry.ts }, false)
          } else {
            const replace = !!(entry.streaming && entry.blockId != null)
            this.pushMonitorLog({ ...entry }, replace)
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
        const box = this.$refs.pmLogBox
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
      void this.monitorTick // 1초마다 재렌더 트리거
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
        const idx = this.commands.findIndex(c => c.id === commandId)
        if (idx >= 0) {
          this.commands[idx] = data.command
        }
        await this.loadCommands()
      } finally {
        this.terminatingId = null
      }
    },
    async retryCommand(commandId) {
      this.retryingId = commandId
      try {
        const { error } = await useApi(`/api/commands/${commandId}/retry`, {
          method: 'POST',
        })
        if (error) {
          alert('재실행 실패: ' + (typeof error === 'string' ? error : '알 수 없는 오류'))
          return
        }
        await this.loadCommands()
      } finally {
        this.retryingId = null
      }
    }
  }
}
</script>
