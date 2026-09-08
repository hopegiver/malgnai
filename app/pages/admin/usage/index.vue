<template>
  <div>
    <div v-if="!guardReady"></div>

    <template v-else-if="!allowed">
      <div class="alert alert-warning"><i class="bi bi-shield-lock me-1"></i>관리자만 접근할 수 있는 화면입니다.</div>
    </template>

    <template v-else>
      <div class="d-flex justify-content-between align-items-start mb-4 flex-wrap gap-2">
        <div>
          <h1 class="mb-1">사용량 통계</h1>
          <div class="text-faint small">
            출처: 사내 Prometheus(OTel) 실측치 — 자체수집 값과 다를 수 있습니다
            <span v-if="meta && meta.rollup && meta.rollup.last_sync_at"> · 롤업 마지막 집계 {{ formatDate(meta.rollup.last_sync_at) }}</span>
          </div>
        </div>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <UsagePeriodPreset v-model="presetKey" :disabled="loading" @change="onPeriodChange" />
          <!-- 공용 워크스테이션 레지스트리 관리(docs/api.md §5.9.9) — 별도 페이지를 새로 만들지 않고
               이 화면 안의 모달로 둔다. 등록/해제 판단에 필요한 근거(관측 이름·기간 사용량·이름
               일치 경고)가 전부 이 목록에 있고, 레지스트리는 수십 행 규모라 전용 라우트를 새로
               파면 같은 정보를 두 화면이 각자 렌더해 드리프트만 생긴다. 다만 "한 번도 관측된 적
               없는 등록"(§5.9.9 기타 동작)은 표에 행이 없어 해제할 수단이 사라지므로, 목록 자체를
               보여주는 이 모달이 그 유일한 출구가 된다. -->
          <button class="btn btn-sm btn-outline-secondary" @click="openSharedManage" :disabled="loading">
            <i class="bi bi-pc-display me-1"></i>공용 워크스테이션 관리<span v-if="registryRows.length"> ({{ registryRows.length }})</span>
          </button>
          <button class="btn btn-sm btn-outline-secondary" @click="load" :disabled="loading" title="새로고침">
            <i class="bi" :class="loading ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'"></i>
          </button>
        </div>
      </div>

      <div v-if="loading" class="row g-3 mb-4">
        <div class="col-6 col-lg-3" v-for="n in 4" :key="n">
          <div class="card p-3 placeholder-glow"><span class="placeholder col-7 mb-2"></span><span class="placeholder col-4" style="height:1.75rem"></span></div>
        </div>
      </div>

      <div v-else-if="error" class="alert alert-warning d-flex justify-content-between align-items-center">
        <span><i class="bi bi-exclamation-triangle me-1"></i>{{ errorMessage }}</span>
        <button v-if="errorRetryable" class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
      </div>

      <template v-else>
        <div v-if="partialErrorMessage" class="alert alert-warning py-2 small mb-3 d-flex justify-content-between align-items-center">
          <span><i class="bi bi-exclamation-triangle me-1"></i>{{ partialErrorMessage }}</span>
          <button v-if="partialErrorRetryable" class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
        </div>

        <!-- 레지스트리 조회 실패(M-4) — 지금까지는 관리 모달을 열어야만 알 수 있었다. 이 상태에서
             라벨 편집 모달을 열면 프리필이 비어 있고, 저장하면 기존 라벨·메모가 감사기록 없이
             삭제된다(PUT은 두 컬럼 전면 교체). 그래서 실패 사실을 화면에 드러내고 편집을 잠근다.
             사용량 수치는 서버가 이미 판정해 내려주므로 이 목록과 무관하다. -->
        <div v-if="registryFailed" class="alert alert-warning py-2 small mb-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
          <span>
            <i class="bi bi-exclamation-triangle me-1"></i>
            공용 워크스테이션 목록(라벨·메모)을 불러오지 못했습니다. 공용 축의 라벨·메모가 비어 보일 수 있고, 기존 값이 지워지는 것을 막기 위해 <strong>라벨 편집을 잠갔습니다</strong>. 사용량 수치 자체는 영향을 받지 않습니다.
          </span>
          <button type="button" class="btn btn-sm btn-outline-secondary" @click="loadRegistry">다시 시도</button>
        </div>

        <div v-if="usersMeta && usersMeta.truncated" class="alert alert-info py-2 small mb-3">
          <i class="bi bi-info-circle me-1"></i>사용자가 많아 상위 {{ usersMeta.limit }}명만 표시 중입니다(전체 목록은 정렬 기준을 바꿔 확인하세요).
        </div>

        <!-- 미연결 관측 배너(설계 §7.3-B ①) — 어떤 허브 계정에도 걸리지 않은 employee_id 관측치가
             몇 건인지 알리고, 아래 목록을 미연결 행만 보이도록 필터해 연결 흐름으로 들어가게 한다.
             prometheus_only 행은 어떤 토글로도 숨기지 않는다(§6.2·§7.1 비협상) — 이 배너도 숨기는
             쪽이 아니라 찾기 쉽게 만드는 쪽이다. -->
        <div v-if="unlinkedCount" class="alert alert-info py-2 small mb-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
          <span>
            <i class="bi bi-link-45deg me-1"></i>허브 계정에 연결되지 않은 관측 {{ unlinkedCount }}건이 있습니다.
            <template v-if="sharedRowCount">이 중 {{ sharedRowCount }}건은 공용 워크스테이션으로 등록돼 있어 개인 계정에 연결하지 않습니다.</template>
            <template v-if="nameMatchRowCount"><br /><i class="bi bi-exclamation-triangle me-1"></i>{{ nameMatchRowCount }}건은 관측 이름이 이미 다른 축에 연결된 회원과 같습니다 — 공용 PC일 수 있으니 연결 전에 확인하세요.</template>
          </span>
          <button type="button" class="btn btn-sm btn-outline-secondary" @click="onlyUnlinked = true">미연결 목록만 보기</button>
        </div>

        <!-- 공용 축에 연결된 회원(shared_workstation_conflict, docs/api.md §5.9.2) — 쓰기 경로가
             막고 있어 정상 운영에서는 나오지 않는 상태다. 나오면 직접 DB 조작 등의 흔적이므로
             숫자가 0인 이유를 설명 없이 두지 않는다. 자동 복구 버튼은 두지 않는다(관리자가
             의도적으로 연동 해제 → 필요 시 재연결의 2단계를 밟아야 한다). -->
        <div v-if="conflictRows.length" class="alert alert-danger py-2 small mb-3">
          <i class="bi bi-exclamation-octagon me-1"></i>
          회원 {{ conflictRows.length }}명의 연동 아이디가 공용 워크스테이션 축으로 등록돼 있어 <strong>사용량이 그 회원에게 귀속되지 않습니다</strong>(표에서 0으로 표시).
          해당 회원({{ conflictRows.map((r) => r.name || r.email).join(', ') }})의 연동 아이디를 <router-link to="/admin/users">사용자 관리</router-link>에서 개인 축으로 바꾸거나, 공용 등록을 해제해야 합니다.
        </div>

        <!-- 상류(Grafana/Prometheus) 장애 — 오늘(라이브 구간)만 못 가져온 것이며 과거 데이터는 정상이다.
             에러 화면으로 바꾸지 않고 경고 배너로만 알린다(§12.1). gap_days 중 라이브 구간에 속한
             날짜는 여기 개수로만 알리고, 아래 "지금 채우기" 배너에는 중복해서 넣지 않는다(M-1 —
             "곧 채워짐(Cron)"과 "지금 재시도해야 함(상류 장애)"은 대응이 달라 뭉치면 안 된다). -->
        <div v-if="meta && meta.live_unavailable" class="alert alert-warning py-2 small mb-3 d-flex justify-content-between align-items-center">
          <span><i class="bi bi-exclamation-triangle me-1"></i>실시간 구간을 가져오지 못해 {{ (meta.segments && meta.segments.cached && meta.segments.cached.to) || '이전' }}까지만 표시합니다{{ gapDayGroups.live.length ? `(${gapDayGroups.live.length}일치)` : '' }}. 자동 적재 대상이 아니므로 다시 시도해야 채워집니다. 과거 데이터는 정상입니다.</span>
          <button class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
        </div>

        <!-- 롤업 캐시가 아직 못 채운 결손일(수집 이전·라이브 실패로 분류된 날짜는 제외, M-1) —
             Cron이 곧 채우는 "기다리면 되는" 상황이라 위 live_unavailable(상류 장애)과는 다른 배너로
             구분한다(§12.1). -->
        <div v-if="gapDayGroups.rollup.length" class="alert alert-info py-2 small mb-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
          <span><i class="bi bi-info-circle me-1"></i>{{ gapDayGroups.rollup.length }}일치가 아직 롤업 적재되지 않았습니다({{ gapDayGroups.rollup.join(', ') }}). 자동 적재를 기다리거나 지금 채울 수 있습니다.</span>
          <button class="btn btn-sm btn-outline-secondary" @click="syncGaps" :disabled="syncing">
            <span v-if="syncing" class="spinner-border spinner-border-sm me-1"></span>지금 채우기
          </button>
        </div>
        <!-- "지금 채우기" 결과 — 실제로 채운 날/애초에 채울 결손이 없던 경우/설정이 안 돼 아무것도
             못한 경우를 구분한다(C-1). 실패·설정문제는 위험색으로, 진짜 성공만 success로 표시한다. -->
        <div v-if="syncResultMessage" class="alert py-2 small mb-3" :class="`alert-${syncResultVariant}`">{{ syncResultMessage }}</div>

        <div v-if="meta && meta.window_clamped" class="alert alert-secondary py-2 small mb-3">
          <i class="bi bi-info-circle me-1"></i>수집 시작일({{ meta.data_start }}) 이전 구간은 데이터가 없습니다.
        </div>

        <div v-if="meta && meta.stale" class="alert alert-warning py-2 small mb-3">
          <i class="bi bi-info-circle me-1"></i>최신 데이터를 가져오지 못해 {{ (meta.cache && meta.cache.age_seconds) || 0 }}초 전 데이터를 표시 중입니다.
        </div>

        <!-- KPI 4종: 회사 전체(day_at 합산). summaryFailed/usersFailed는 M-3(부분 실패를 0으로 표시
             금지) — 모르는 값은 '—'로, gapDayCount는 M-6(결손이 있으면 합계는 하한) 처리. -->
        <div class="row g-3 mb-4">
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--primary p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-broadcast"></i></span><span class="pd-stat-label">세션</span></div>
              <div class="pd-stat-value">{{ summaryFailed ? '—' : (gapDayCount ? '≥' : '') + totals.sessions }}</div>
              <div class="pd-stat-sub">{{ summaryFailed ? '불러오지 못함' : (gapDayCount ? `전사 · 결손 ${gapDayCount}일 제외(하한)` : '전사 · 선택 기간') }}</div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--info p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-coin"></i></span><span class="pd-stat-label">총 토큰</span></div>
              <div class="pd-stat-value">{{ summaryFailed ? '—' : (gapDayCount ? '≥' : '') + formatTokens(totals.tokens) }}</div>
              <div class="pd-stat-sub">{{ summaryFailed ? '불러오지 못함' : '입력+출력+캐시' }}</div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--success p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-cash-coin"></i></span><span class="pd-stat-label">추정 비용</span></div>
              <div class="pd-stat-value">{{ summaryFailed ? '—' : (gapDayCount ? '≥' : '') + formatCost(totals.cost) }}</div>
              <div class="pd-stat-sub">{{ summaryFailed ? '불러오지 못함' : (gapDayCount ? `결손 ${gapDayCount}일 제외(하한, USD)` : '전사 · 선택 기간(USD)') }}</div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card pd-stat pd-stat--neutral p-3">
              <div class="pd-stat-top"><span class="pd-stat-icon"><i class="bi bi-people"></i></span><span class="pd-stat-label">활동 사용자</span></div>
              <div class="pd-stat-value">{{ usersFailed ? '—' : activeUserCount }}<span class="text-muted" style="font-size:var(--font-size-lg)">/{{ usersFailed ? '—' : (usersMeta && usersMeta.truncated ? '≥' + users.length : users.length) }}</span></div>
              <div class="pd-stat-sub">{{ usersFailed ? '불러오지 못함' : '표시된 사용자 중(미등록 포함) · 선택 기간 내 세션 발생' }}</div>
            </div>
          </div>
        </div>

        <!-- 전사 일별 토큰 사용량 -->
        <div class="card p-4 mb-3" v-if="chartData.length">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="h6 mb-0">전사 일별 토큰 사용량</h2>
            <span class="text-faint small">최근 {{ chartData.length }}일</span>
          </div>
          <div class="usage-chart" role="img" :aria-label="`전사 일별 토큰 사용량, ${meta && meta.from}~${meta && meta.to}${gapDayCount ? `, 결손 ${gapDayCount}일 포함` : ''}`">
            <div class="usage-chart-bars">
              <div
                v-for="d in chartData"
                :key="d.day"
                class="usage-chart-col"
                :class="{ 'usage-chart-col--gap': d.isGap }"
                :title="d.isGap ? `${d.day} · 아직 집계되지 않음` : `${d.day} · ${formatTokens(d.tokens)} 토큰`"
              >
                <span class="usage-chart-value">{{ d.isGap ? '—' : formatTokens(d.tokens) }}<span v-if="d.isGap" class="visually-hidden">(집계 안 됨)</span></span>
                <!-- M-2: 결측은 막대(높이로 크기 비교되는 형태)가 아니라 전체 높이 옅은 해칭 밴드 +
                     0과 같은 높이(2px)의 작은 마커로 그린다 — 예전 12px 막대는 진짜 0(2px)보다
                     커 보여 "결손"이 "다량 사용"으로 오독됐다. -->
                <div v-if="d.isGap" class="usage-chart-gap-band" aria-hidden="true"><div class="usage-chart-gap-marker"></div></div>
                <div v-else class="usage-chart-bar" :style="{ height: d.barPx + 'px' }"></div>
              </div>
            </div>
            <div class="usage-chart-axis">
              <span v-for="d in chartData" :key="d.day" class="usage-chart-label">{{ d.shortDay }}</span>
            </div>
          </div>
        </div>
        <div v-else-if="summaryFailed" class="text-center py-5 mb-3">
          <i class="bi bi-exclamation-triangle d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
          <div class="fw-medium mb-1 text-muted">전사 일별 사용량을 불러오지 못했습니다(위 배너 참고)</div>
        </div>
        <div v-else class="text-center py-5 mb-3">
          <i class="bi bi-bar-chart d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
          <div class="fw-medium mb-1 text-muted">선택 기간에 사용량 데이터가 없습니다</div>
        </div>

        <!-- 사용자별 합계 랭킹 -->
        <div class="card p-0">
          <div class="d-flex justify-content-between align-items-center p-3 pb-0 flex-wrap gap-2">
            <h2 class="h6 mb-0">사용자별 사용량</h2>
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <span v-if="onlyUnlinked" class="badge bg-info text-dark d-flex align-items-center gap-1">
                미연결만 표시 중
                <button type="button" class="btn-close" style="font-size:0.55rem" @click="onlyUnlinked = false" aria-label="필터 해제"></button>
              </span>
              <!-- §6.2 비활성+무사용 접기 — 0인 행만 접으므로 표 합계는 산술적으로 불변이다. -->
              <button v-if="hiddenDisabledCount" type="button" class="btn btn-sm btn-outline-secondary" @click="showHiddenDisabled = !showHiddenDisabled">
                {{ showHiddenDisabled ? `숨기기(비활성·무사용 ${hiddenDisabledCount}건)` : `비활성·무사용 계정 ${hiddenDisabledCount}건 숨김 · 모두 보기` }}
              </button>
              <small class="text-faint" v-if="usersMeta">{{ usersMeta.returned }}명 표시</small>
            </div>
          </div>
          <div class="px-3 pt-2">
            <small class="text-faint">도구 호출/턴/API 호출 지표는 Prometheus가 아직 제공하지 않아 표에서 제외했습니다(0건이 아니라 측정 불가).</small>
          </div>
          <div class="table-responsive">
            <table class="table table-hover mb-0">
              <thead>
                <tr>
                  <th>사용자</th>
                  <th>역할/상태</th>
                  <th class="text-end sortable" role="button" @click="setSort('sessions')">세션<i class="bi ms-1" :class="sortIcon('sessions')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('tokens')">총 토큰<i class="bi ms-1" :class="sortIcon('tokens')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('cost')">비용<i class="bi ms-1" :class="sortIcon('cost')"></i></th>
                  <th class="text-end sortable" role="button" @click="setSort('last_active')">마지막 활동<i class="bi ms-1" :class="sortIcon('last_active')"></i></th>
                  <th class="text-end">작업</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="usersLoading"><td colspan="7" class="text-center text-faint py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...</td></tr>
                <tr
                  v-for="u in visibleUsers"
                  v-else
                  :key="u.row_key"
                  :role="u.source === 'prometheus_only' ? undefined : 'button'"
                  @click="goToUser(u)"
                  :class="{
                    'table-secondary': u.session_count === 0,
                    'usage-row--unlinked': u.source === 'prometheus_only',
                    'usage-row--shared': isShared(u),
                    'usage-row--conflict': u.shared_workstation_conflict,
                  }"
                >
                  <td>
                    <template v-if="u.source === 'prometheus_only'">
                      <!-- 미연결 관측 행(§7.1·§7.2) — email이 null이라 employee_id·관측 이름·그룹계정으로
                           대체 표시한다. 공용 워크스테이션 축(identity_source==='shared_workstation',
                           docs/api.md §5.9.2)은 name이 이미 "등록 라벨 또는 employee_id"라 관측 이름이
                           주 이름으로 올라오지 않는다 — 관측 이름은 아래에 부가 정보로만 병기해
                           "개인 관측치"로 오해하지 않게 한다(이 착시가 오귀속 사고의 원인이었다). -->
                      <div class="fw-medium d-flex align-items-center gap-1 flex-wrap">
                        {{ u.name || u.employee_id || '(이름 없음)' }}
                        <span
                          v-if="isShared(u)"
                          class="badge bg-dark"
                          title="여러 명이 함께 쓰는 공용 PC로 등록된 축입니다. 개인 사용량이 아니며 개인 계정에 연결할 수 없습니다."
                        ><i class="bi bi-pc-display me-1"></i>공용 워크스테이션</span>
                        <!-- observed_name_matches_user(§5.9.2, 표시 전용 신호) — 분류에 관여하지 않는다. -->
                        <span
                          v-if="u.observed_name_matches_user"
                          class="badge bg-warning text-dark"
                          :title="nameMatchText(u)"
                        ><i class="bi bi-exclamation-triangle me-1"></i>이름 일치 회원 있음</span>
                      </div>
                      <div class="small text-faint">
                        <span v-if="u.employee_id">employee_id: <code>{{ u.employee_id }}</code></span>
                        <span v-else-if="u.group_accounts.length">{{ u.group_accounts.map((g) => g.user_email).join(', ') }}</span>
                      </div>
                      <div v-if="isShared(u)" class="small text-faint">
                        관측 이름: {{ u.observed_employee_name || '-' }} <span class="text-warning-emphasis">(공용 PC — 개인 사용량 아님)</span>
                      </div>
                      <div v-if="isShared(u) && registryNote(u.employee_id)" class="small text-faint text-truncate usage-cell-note" :title="registryNote(u.employee_id)">{{ registryNote(u.employee_id) }}</div>
                      <div v-if="u.observed_name_matches_user" class="small text-warning-emphasis text-truncate usage-cell-note" :title="nameMatchText(u)">{{ nameMatchText(u) }}</div>
                    </template>
                    <template v-else>
                      <div class="fw-medium d-flex align-items-center gap-1 flex-wrap">
                        {{ u.name || u.email }}
                        <!-- 관측 이름 불일치 경고(§4.4 S4) — 오연결 탐지 신호. -->
                        <span
                          v-if="u.observed_name_mismatch"
                          class="badge bg-warning text-dark"
                          :title="`관측 이름: ${u.observed_employee_name} / 계정 이름: ${u.name} — 연동 아이디를 확인하세요`"
                        ><i class="bi bi-exclamation-triangle me-1"></i>이름 불일치</span>
                        <!-- shared_workstation_conflict(§5.9.2) — 숫자가 0인 이유를 행에서 바로 설명한다. -->
                        <span
                          v-if="u.shared_workstation_conflict"
                          class="badge bg-danger"
                          title="이 회원의 연동 아이디가 공용 워크스테이션으로 등록돼 있어 관측 사용량이 이 회원에게 귀속되지 않습니다(아래 수치는 0)."
                        ><i class="bi bi-exclamation-octagon me-1"></i>공용 축에 연결됨 — 사용량 미귀속</span>
                      </div>
                      <div class="small text-faint">{{ u.email }}</div>
                      <div class="small text-faint">
                        <span v-if="u.employee_id">연동: <code>{{ u.employee_id }}</code></span>
                        <span v-else class="badge bg-light text-dark">미연동</span>
                      </div>
                      <div v-if="u.shared_workstation_conflict" class="small text-danger usage-cell-note">
                        연동 아이디 <code>{{ u.employee_id }}</code>가 공용 PC 축이라 이 행의 사용량은 0으로 표시됩니다(관측치는 별도 공용 워크스테이션 행에 남습니다).
                      </div>
                    </template>
                  </td>
                  <td>
                    <template v-if="u.source === 'prometheus_only'">
                      <span v-if="isShared(u)" class="badge bg-dark" title="공용 워크스테이션 축 — 개인 계정이 아니므로 드릴다운(개인 상세)이 없습니다">공용 PC</span>
                      <span v-else class="badge bg-light text-dark" title="malgnai-hub 계정과 매칭되지 않아 드릴다운을 열 수 없습니다">미등록</span>
                    </template>
                    <template v-else>
                      <span class="badge me-1" :class="userRoleMeta(u.role).cls">{{ userRoleMeta(u.role).label }}</span>
                      <span class="badge" :class="userStatusMeta(u.status).cls">{{ userStatusMeta(u.status).label }}</span>
                    </template>
                  </td>
                  <td class="text-end">{{ u.session_count }}</td>
                  <td class="text-end">{{ formatTokens(u.total_tokens) }}</td>
                  <td class="text-end">{{ formatCost(u.cost_usd) }}</td>
                  <td class="text-end text-nowrap">{{ u.last_active_day || '-' }}</td>
                  <!-- 미연결 관측 행의 작업은 단일 "연결"이 아니라 2지선다다(docs/design/
                       usage-shared-workstation-axes.md §5.6-A①). 자동 판정에 쓸 신호가 데이터에 없으므로,
                       관리자가 그 축을 처음 보는 순간에 "개인인가 공용인가"를 판단하게 만드는 것이
                       유일한 방어선이다 — 개인 연결로 곧장 이어지는 단일 경로를 두지 않는다. -->
                  <!-- 두 버튼은 가로로 늘어놓으면 표 전체가 뷰포트를 넘겨 작업 열이 가로 스크롤
                       밖으로 밀려난다(1440에서 실측). 세로로 쌓아 열 폭을 버튼 1개분으로 유지한다. -->
                  <td class="text-end usage-actions-cell" @click.stop>
                    <div class="d-flex flex-column align-items-end gap-1">
                      <template v-if="isShared(u)">
                        <!-- 레지스트리를 못 읽은 상태에서는 라벨 편집을 막는다(M-4) — 모달 프리필이
                             this.registry에서 오므로, 실패 상태로 열면 빈 값이 채워지고 그대로
                             저장하면 기존 라벨·메모가 감사기록 없이 전면 삭제된다. -->
                        <button
                          type="button"
                          class="btn btn-sm btn-outline-secondary text-nowrap"
                          :disabled="registryFailed"
                          :title="registryFailed ? '공용 워크스테이션 목록을 불러오지 못해 편집할 수 없습니다(기존 라벨·메모가 지워질 수 있음). 새로고침 후 다시 시도하세요.' : ''"
                          @click="openRegister(u, 'edit')"
                        >라벨 편집</button>
                        <button type="button" class="btn btn-sm btn-outline-danger text-nowrap" :disabled="registryBusyId === u.employee_id" @click="unregisterShared(u.employee_id)">등록 해제</button>
                      </template>
                      <!-- 공용 축에 연결된 회원 행(shared_workstation_conflict) — 이 행은 공용 축이
                           아니라 잘못된 연동 값을 가진 사람이다. 여기서 공용 레지스트리를 조작하게
                           두지 않고(그건 관측 행의 작업이다), 조치 지점인 사용자 관리로 보낸다. -->
                      <template v-else-if="u.shared_workstation_conflict">
                        <router-link to="/admin/users" class="btn btn-sm btn-outline-danger text-nowrap">사용자 관리로 이동</router-link>
                      </template>
                      <template v-else-if="u.source === 'prometheus_only' && u.employee_id">
                        <button type="button" class="btn btn-sm btn-outline-primary text-nowrap" @click="openConnect(u)">개인 계정에 연결</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary text-nowrap" @click="openRegister(u, 'register')">공용 PC로 등록</button>
                      </template>
                    </div>
                  </td>
                </tr>
                <tr v-if="!usersLoading && !visibleUsers.length && usersFailed"><td colspan="7" class="text-center text-muted py-4">사용자별 목록을 불러오지 못했습니다(위 배너 참고).</td></tr>
                <tr v-else-if="!usersLoading && !visibleUsers.length"><td colspan="7" class="text-center text-muted py-4">표시할 사용자가 없습니다.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </template>

    <!-- 미연결 관측치 연결 모달(§7.3-B ②) — 사용자 선택 → PUT /api/admin/users/<선택 user.id>/employee-id
         { employee_id: row.employee_id }. 실제 API 왕복이며, 성공 후 load()로 목록을 반드시 재조회한다
         (귀속이 바뀌면 다른 행의 수치도 함께 변하므로). -->
    <div v-if="connectModal.open" class="modal-backdrop-custom" @click.self="closeConnect">
      <div class="modal-dialog-custom" style="width:520px;max-width:92vw;">
        <div class="modal-content">
          <div class="modal-header d-flex justify-content-between align-items-center">
            <h5 class="mb-0">관측치를 허브 계정에 연결</h5>
            <button type="button" class="btn-close" aria-label="닫기" @click="closeConnect"></button>
          </div>
          <div class="modal-body">
            <div class="card p-2 mb-3 bg-canvas">
              <div class="small text-faint">employee_id</div>
              <div class="fw-medium">{{ connectModal.row.employee_id || '(라벨 없음)' }}</div>
              <div class="small text-faint mt-2">관측 이름</div>
              <div>{{ connectModal.row.observed_employee_name || '-' }}</div>
              <div class="small text-faint mt-2">선택 기간 사용량</div>
              <div class="small">세션 {{ connectModal.row.session_count }} · 토큰 {{ formatTokens(connectModal.row.total_tokens) }} · {{ formatCost(connectModal.row.cost_usd) }}</div>
              <div class="small text-faint mt-2">그룹 계정</div>
              <div class="small">{{ connectModal.row.group_accounts.map((g) => g.user_email).join(', ') || '-' }}</div>
            </div>

            <!-- 이름 일치 경고(§4.6) — 연결을 누르기 직전에 보여야 의미가 있다. 분류 신호가 아니라
                 "사람이 공용 PC를 발견하도록 돕는" 표시 전용 정보다. -->
            <div v-if="connectModal.row.observed_name_matches_user" class="alert alert-warning py-2 small">
              <i class="bi bi-exclamation-triangle me-1"></i>{{ nameMatchText(connectModal.row) }}
              이 관측치가 공용 PC일 수 있으니 연결 전에 확인하고, 공용 PC라면 <strong>연결 대신 "공용 PC로 등록"</strong>을 선택하세요.
            </div>

            <div class="alert alert-secondary py-2 small">
              <i class="bi bi-info-circle me-1"></i>여러 명이 함께 쓰는 PC의 축을 개인 계정에 연결하면 그룹 전체 사용량이 그 한 사람의 개인 사용량으로 표시됩니다. 개인 PC가 확실할 때만 연결하세요.
            </div>

            <label class="form-label small fw-semibold" for="connectSearch">연결할 사용자 검색</label>
            <input id="connectSearch" v-model="connectModal.query" type="text" class="form-control mb-2" placeholder="이름 또는 이메일" :disabled="connectModal.submitting" />

            <div class="border border-hairline rounded" style="max-height:220px; overflow-y:auto;">
              <div
                v-for="u in connectCandidates"
                :key="u.user_id"
                class="p-2 d-flex justify-content-between align-items-center connect-candidate"
                :class="{ 'connect-candidate--selected': connectModal.selectedUserId === u.user_id }"
                role="button"
                @click="connectModal.selectedUserId = u.user_id"
              >
                <div>
                  <div class="fw-medium">{{ u.name }}</div>
                  <div class="small text-faint">{{ u.email }}</div>
                </div>
                <span class="small text-faint">{{ u.employee_id ? `현재: ${u.employee_id}` : '미연동' }}</span>
              </div>
              <div v-if="!connectCandidates.length" class="p-3 text-center text-faint small">일치하는 사용자가 없습니다.</div>
            </div>

            <!-- 409는 두 종류다: CONFLICT(다른 회원이 이미 보유) / SHARED_WORKSTATION(공용 축).
                 조치가 다르므로 문구를 분기한다. 공용 축은 자동 해제 버튼을 만들지 않는다
                 (docs/api.md §5.9.6 — 선해제는 관리자가 의도적으로 2회 조작해야 한다). -->
            <div v-if="connectModal.sharedConflict" class="alert alert-danger py-2 small mt-3 mb-0">
              <i class="bi bi-pc-display me-1"></i>이 축(<code>{{ connectModal.sharedConflict.employee_id }}</code>)은
              <strong>공용 워크스테이션({{ connectModal.sharedConflict.label || connectModal.sharedConflict.employee_id }})</strong>으로 등록돼 있어 개인 계정에 연결할 수 없습니다.
              여러 명이 함께 쓰는 PC라 그룹 전체 사용량이 한 사람에게 잘못 귀속됩니다.
              <div class="mt-1">정말 개인 축이라면 <strong>먼저 "공용 워크스테이션 관리"에서 이 축의 등록을 해제한 뒤</strong> 다시 연결하세요(자동 해제는 제공하지 않습니다).</div>
              <div class="text-faint mt-1">등록일 {{ formatDate(connectModal.sharedConflict.registered_at) }}</div>
            </div>
            <div v-else-if="connectModal.error" class="alert alert-danger py-2 small mt-3 mb-0">
              {{ connectModal.error }}
              <div v-if="connectModal.conflict" class="mt-1">
                이미 <strong>{{ connectModal.conflict.conflict_email }}</strong> 사용자가 이 값을 쓰고 있습니다. 먼저 그 사용자의 연동을 해제해야 합니다(자동 이전은 지원하지 않습니다).
              </div>
            </div>
          </div>
          <div class="modal-footer d-flex justify-content-end gap-2">
            <button type="button" class="btn btn-outline-secondary" :disabled="connectModal.submitting" @click="closeConnect">취소</button>
            <button type="button" class="btn btn-primary" :disabled="connectModal.submitting || !connectModal.selectedUserId" @click="confirmConnect">
              <span v-if="connectModal.submitting" class="spinner-border spinner-border-sm me-2"></span>연결
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 공용 워크스테이션 등록/라벨 편집 모달(docs/api.md §5.9.9) —
         PUT /api/admin/usage/shared-workstations/<encodeURIComponent(employee_id)>.
         경로가 정본이므로 본문에 employee_id를 담지 않는다(서버가 무시). -->
    <div v-if="registerModal.open" class="modal-backdrop-custom" @click.self="closeRegister">
      <div class="modal-dialog-custom" style="width:520px;max-width:92vw;">
        <div class="modal-content">
          <div class="modal-header d-flex justify-content-between align-items-center">
            <h5 class="mb-0">{{ registerModal.mode === 'edit' ? '공용 워크스테이션 정보 편집' : '공용 워크스테이션으로 등록' }}</h5>
            <button type="button" class="btn-close" aria-label="닫기" @click="closeRegister"></button>
          </div>
          <div class="modal-body">
            <div class="card p-2 mb-3 bg-canvas">
              <div class="small text-faint">employee_id</div>
              <div class="fw-medium"><code>{{ registerModal.employeeId }}</code></div>
              <div class="small text-faint mt-2">관측 이름</div>
              <div>{{ registerModal.observedName || '-' }}</div>
              <div class="small text-faint mt-2">선택 기간 사용량</div>
              <div class="small">토큰 {{ formatTokens(registerModal.totalTokens) }} · {{ formatCost(registerModal.costUsd) }}</div>
            </div>

            <div v-if="registerModal.mode === 'register'" class="alert alert-secondary py-2 small">
              <i class="bi bi-info-circle me-1"></i>등록하면 이 축은 <strong>개인 사용량으로 표시되지 않고</strong> 개인 계정에 연결할 수도 없게 됩니다(연결하려면 나중에 등록을 해제해야 합니다). 총합은 변하지 않고 귀속만 이동합니다.
            </div>

            <label class="form-label small fw-semibold" for="swLabel">라벨(선택)</label>
            <input id="swLabel" v-model="registerModal.label" type="text" class="form-control mb-1" maxlength="100" placeholder="예: 3층 공용 PC" :disabled="registerModal.submitting" />
            <div class="small text-faint mb-3">목록에서 이 축의 이름으로 표시됩니다(비우면 employee_id 그대로). 최대 100자.</div>

            <label class="form-label small fw-semibold" for="swNote">메모(선택)</label>
            <textarea id="swNote" v-model="registerModal.note" class="form-control mb-1" rows="2" maxlength="500" placeholder="예: 영업팀 공용, 4~5명 사용" :disabled="registerModal.submitting"></textarea>
            <div class="small text-faint mb-0">최대 500자.</div>

            <div v-if="registerModal.error" class="alert alert-danger py-2 small mt-3 mb-0">
              {{ registerModal.error }}
              <div v-if="registerModal.conflict" class="mt-1">
                이 값은 현재 <strong>{{ registerModal.conflict.conflict_email }}</strong> 회원의 연동 아이디입니다. 먼저 <router-link to="/admin/users">사용자 관리</router-link>에서 그 회원의 연동을 해제한 뒤 등록하세요.
              </div>
            </div>
          </div>
          <div class="modal-footer d-flex justify-content-end gap-2">
            <button type="button" class="btn btn-outline-secondary" :disabled="registerModal.submitting" @click="closeRegister">취소</button>
            <button type="button" class="btn btn-primary" :disabled="registerModal.submitting" @click="confirmRegister">
              <span v-if="registerModal.submitting" class="spinner-border spinner-border-sm me-2"></span>{{ registerModal.mode === 'edit' ? '저장' : '공용 PC로 등록' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 공용 워크스테이션 레지스트리 관리 모달 — 목록/라벨·메모 편집/등록 해제.
         관측된 적 없는 등록(표에 행이 없는 항목)도 여기서만 확인·해제할 수 있다. -->
    <div v-if="sharedManage.open" class="modal-backdrop-custom" @click.self="closeSharedManage">
      <div class="modal-dialog-custom" style="width:860px;max-width:94vw;">
        <div class="modal-content">
          <div class="modal-header d-flex justify-content-between align-items-center">
            <h5 class="mb-0">공용 워크스테이션 관리</h5>
            <button type="button" class="btn-close" aria-label="닫기" @click="closeSharedManage"></button>
          </div>
          <div class="modal-body">
            <p class="small text-faint">
              여러 명이 함께 쓰는 PC의 <code>employee_id</code> 축입니다. 등록된 축은 개인 사용량으로 표시되지 않고 개인 계정에 연결할 수 없습니다.
              등록/해제는 즉시(과거 구간까지 소급) 반영되며 전사 총합은 변하지 않습니다 — 귀속만 이동합니다.
            </p>

            <div v-if="sharedManage.error" class="alert alert-danger py-2 small">{{ sharedManage.error }}</div>

            <div v-if="sharedManage.loading" class="text-center text-faint py-4"><span class="spinner-border spinner-border-sm me-2"></span>불러오는 중...</div>
            <div v-else-if="!registryRows.length" class="text-center text-muted py-4 small">등록된 공용 워크스테이션이 없습니다. 목록의 미연결 관측 행에서 “공용 PC로 등록”을 눌러 추가하세요.</div>
            <div v-else class="table-responsive">
              <table class="table table-sm align-middle mb-0">
                <thead>
                  <tr><th>employee_id</th><th>라벨/메모</th><th>등록일</th><th class="text-end">작업</th></tr>
                </thead>
                <tbody>
                  <tr v-for="r in registryRows" :key="r.employee_id">
                    <td class="text-nowrap">
                      <code>{{ r.employee_id }}</code>
                      <div v-if="!observedEmployeeIds.has(r.employee_id)" class="small text-faint">선택 기간 관측 없음</div>
                    </td>
                    <td>
                      <template v-if="sharedManage.editingId === r.employee_id">
                        <input v-model="sharedManage.form.label" type="text" class="form-control form-control-sm mb-1" maxlength="100" placeholder="라벨(최대 100자)" :disabled="sharedManage.saving" />
                        <textarea v-model="sharedManage.form.note" class="form-control form-control-sm" rows="2" maxlength="500" placeholder="메모(최대 500자)" :disabled="sharedManage.saving"></textarea>
                      </template>
                      <template v-else>
                        <div class="fw-medium">{{ r.label || '(라벨 없음)' }}</div>
                        <div class="small text-faint text-truncate usage-registry-note" :title="r.note || ''">{{ r.note || '-' }}</div>
                      </template>
                    </td>
                    <td class="text-nowrap small text-faint">{{ formatDate(r.created_at) }}</td>
                    <td class="text-end">
                      <div class="d-flex justify-content-end gap-2 flex-wrap">
                        <template v-if="sharedManage.editingId === r.employee_id">
                          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="sharedManage.saving" @click="sharedManage.editingId = null">취소</button>
                          <button type="button" class="btn btn-sm btn-primary" :disabled="sharedManage.saving" @click="saveRegistryEdit(r)">
                            <span v-if="sharedManage.saving" class="spinner-border spinner-border-sm me-1"></span>저장
                          </button>
                        </template>
                        <template v-else>
                          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="registryBusyId === r.employee_id" @click="startRegistryEdit(r)">편집</button>
                          <button type="button" class="btn btn-sm btn-outline-danger" :disabled="registryBusyId === r.employee_id" @click="unregisterShared(r.employee_id)">등록 해제</button>
                        </template>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="modal-footer d-flex justify-content-end">
            <button type="button" class="btn btn-outline-secondary" @click="closeSharedManage">닫기</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: '사용량 통계 · malgnai-hub',
  data() {
    const initial = usagePeriodRange('today')
    return {
      guardReady: false,
      allowed: false,

      presetKey: 'today',
      from: initial.from,
      to: initial.to,

      loading: true,
      error: false,
      errorMessage: '',
      errorRetryable: true,
      partialErrorMessage: '',
      partialErrorRetryable: true,

      summaryRows: [],
      meta: null, // /summary 응답의 meta(gap_days/live_unavailable/segments/rollup 등, §5.0)
      summaryFailed: false, // M-3: summary API가 실패했는지(0으로 위장하지 않기 위한 별도 플래그)
      users: [],
      usersMeta: null,
      usersFailed: false, // M-3: users API가 실패했는지
      usersLoading: false,

      syncing: false,
      syncResultMessage: '',
      syncResultVariant: 'secondary', // C-1: success|warning|danger|secondary — 실제 결과에 맞춘 색

      sort: 'tokens',
      order: 'desc',

      // §6.2 비활성+무사용 접기 토글, §7.3-B ① 미연결 전용 필터. prometheus_only 행은 어느 쪽
      // 필터에도 걸리지 않는다(status는 절대 'disabled'가 아니므로 showHiddenDisabled와 무관).
      showHiddenDisabled: false,
      onlyUnlinked: false,

      // §7.3-B ② 미연결 관측치 연결 모달 상태. sharedConflict는 409 SHARED_WORKSTATION 전용
      // (기존 409 CONFLICT와 조치가 달라 분리한다, docs/api.md §5.9.6).
      connectModal: { open: false, row: null, query: '', selectedUserId: null, submitting: false, error: '', conflict: null, sharedConflict: null },

      // 공용 워크스테이션 레지스트리(docs/api.md §5.9.9). 목록은 users 응답과 별개로 1회 더
      // 받는다 — users 행에는 라벨/메모/등록일이 없고, "한 번도 관측된 적 없는 등록"은 아예
      // 행으로 오지 않기 때문에 이 목록이 없으면 해제할 방법이 사라진다.
      registry: [],
      registryFailed: false,
      registryBusyId: null,
      registerModal: { open: false, mode: 'register', employeeId: '', observedName: '', totalTokens: 0, costUsd: 0, label: '', note: '', submitting: false, error: '', conflict: null },
      sharedManage: { open: false, loading: false, error: '', editingId: null, form: { label: '', note: '' }, saving: false },
    }
  },
  computed: {
    totals() {
      const t = { sessions: 0, tokens: 0, cost: 0 }
      for (const r of this.summaryRows) {
        t.sessions += r.session_count || 0
        t.tokens += (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0)
        t.cost += r.cost_usd || 0
      }
      return t
    },
    // 날짜축을 서버 응답이 아니라 meta.from~to로 스스로 채운다 — meta.gap_days(결손일)는 data[]에
    // 행 자체가 없으므로, summaryRows만으로 v-for를 돌리면 그 날짜가 조용히 사라져(=0으로 보여)
    // "아무도 안 썼다"는 거짓 표시가 된다(§12.1). 커버는 됐지만 실사용이 0인 날과, 아예 못 채운
    // gap_days를 구분해서 렌더한다.
    chartData() {
      if (!this.meta || !this.meta.from || !this.meta.to) return []
      const gapSet = new Set(this.meta.gap_days || [])
      const byDay = new Map(this.summaryRows.map((r) => [r.day_at, r]))
      const rows = enumerateUsageDays(this.meta.from, this.meta.to).map((day) => {
        const isGap = gapSet.has(day)
        const row = byDay.get(day)
        const tokens = isGap ? 0 : (row ? row.total_tokens : 0)
        return { day, tokens, isGap }
      })
      const max = Math.max(1, ...rows.filter((r) => !r.isGap).map((r) => r.tokens))
      const maxBarPx = 140
      const gapMarkerPx = 2 // M-2: 결측 마커는 0인 날의 최소 막대(2px)와 같은 높이로 — "0보다 커 보임" 오독 방지
      return rows.map((r) => ({
        ...r,
        barPx: r.isGap ? gapMarkerPx : Math.max(2, Math.round((r.tokens / max) * maxBarPx)),
        shortDay: r.day.slice(5),
      }))
    },
    activeUserCount() {
      return this.users.filter((u) => (u.session_count || 0) > 0).length
    },
    gapDayCount() {
      return (this.meta && this.meta.gap_days && this.meta.gap_days.length) || 0
    },
    // M-1: meta.gap_days에는 성격이 다른 3종류(수집 이전 / 오늘 라이브 실패 / 진짜 롤업 결손)가
    // 섞여 온다. 배너마다 "기다리면 되는지 / 다시 시도해야 하는지"가 다르므로 분리해서 각 배너가
    // 자기 몫만 말하게 한다(하나로 뭉치면 관리자가 판단할 수 없다, §12.1).
    //
    // 분류 경계로 meta.segments.cached.to(§5.0 "cacheTo = isToday ? yesterday : clampedTo")를 쓴다 —
    // 이 값은 "이번 요청이 캐시로 커버할 수 있는 이론상 상한(=어제)"이라 실제 연속 적재 여부와
    // 무관하다. 그래서 day >= cachedTo인 gap(오늘·어제 등 라이브가 담당했어야 할 구간)만 "라이브
    // 실패"로 보고, 그보다 앞선 날짜(=이미 캐시 대상 구간인데 구멍난 날)는 Cron/수동 적재가
    // 담당하는 "롤업 결손"으로 본다. 실측 확인(2026-09-04, 로컬): live_unavailable=true 상태에서
    // 인위로 만든 중간 결손(cachedTo보다 훨씬 이전 날짜)이 정확히 rollup으로, 실제 오늘/어제
    // 라이브 실패일은 live로 분류됨을 확인했다. data_start·rollup.cached_through만으로는 이 구분이
    // 안 된다(cached_through는 "연속 적재 마지막 날"이라 중간 결손 하나만 있어도 그 이후 전부가
    // "연속 아님"으로 붕괴해 버려, 실제로는 이미 캐시에 있는 최근 날짜까지 라이브로 오분류된다 —
    // 그래서 연속성이 아니라 "이 요청이 캐시에 기대한 상한"인 segments.cached.to를 쓴다).
    gapDayGroups() {
      const gaps = (this.meta && this.meta.gap_days) || []
      const dataStart = this.meta && this.meta.data_start
      const liveUnavailable = !!(this.meta && this.meta.live_unavailable)
      const cachedTo = this.meta && this.meta.segments && this.meta.segments.cached && this.meta.segments.cached.to
      const before = [] // data_start 이전 — 영원히 안 채워짐(window_clamped 배너가 이미 알린다)
      const live = [] // live_unavailable로 오늘(라이브 구간)을 못 가져온 날 — 재시도해야 채워짐
      const rollup = [] // 그 외 — Cron/수동 적재가 채우는 진짜 결손
      for (const day of gaps) {
        if (dataStart && day < dataStart) { before.push(day); continue }
        if (liveUnavailable && (!cachedTo || day >= cachedTo)) { live.push(day); continue }
        rollup.push(day)
      }
      return { before, live, rollup }
    },
    // §7.1 비협상 — 삭제·숨김 금지. 어떤 users 행에도 걸리지 않은 employee_id 관측치.
    unlinkedRows() {
      return this.users.filter((u) => u.source === 'prometheus_only')
    },
    unlinkedCount() {
      return this.unlinkedRows.length
    },
    // 공용 워크스테이션으로 등록된 관측 행. isShared()가 source='prometheus_only'까지 함께 보므로
    // 이 값은 반드시 unlinkedCount의 부분집합이다 — 배너가 "미연결 N건 중 M건은 공용"이라고 말하는
    // 문장이 성립하려면 그래야 한다(회원 행까지 세면 M > N이 되어 개수 문장 자체가 거짓이 된다).
    sharedRowCount() {
      return this.users.filter((u) => this.isShared(u)).length
    },
    nameMatchRowCount() {
      return this.users.filter((u) => u.observed_name_matches_user).length
    },
    // d1_user인데 연동 값이 공용 축이라 사용량이 0으로 표시되는 행(§5.9.2 shared_workstation_conflict).
    conflictRows() {
      return this.users.filter((u) => u.shared_workstation_conflict)
    },
    registryRows() {
      return this.registry
    },
    observedEmployeeIds() {
      return new Set(this.users.map((u) => u.employee_id).filter(Boolean))
    },
    // §6.2 — status='disabled' 이고 해당 기간 사용량이 전부 0인 행만 숨김 대상. 0만 접으므로
    // 표 합계는 산술적으로 불변이다.
    hiddenDisabledCount() {
      return this.users.filter((u) => u.status === 'disabled' && u.session_count === 0 && u.total_tokens === 0 && u.cost_usd === 0).length
    },
    visibleUsers() {
      let list = this.users
      if (this.onlyUnlinked) list = list.filter((u) => u.source === 'prometheus_only')
      if (!this.showHiddenDisabled) {
        list = list.filter((u) => !(u.status === 'disabled' && u.session_count === 0 && u.total_tokens === 0 && u.cost_usd === 0))
      }
      return list
    },
    // 연결 모달의 사용자 검색 후보 — 허브 계정(d1_user)만, 이름/이메일 부분일치.
    connectCandidates() {
      const q = this.connectModal.query.trim().toLowerCase()
      const list = this.users.filter((u) => u.source === 'd1_user')
      if (!q) return list
      return list.filter((u) => (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
    },
  },
  async mounted() {
    const me = await getCurrentUser()
    this.allowed = me?.role === 'administrator'
    this.guardReady = true
    if (!this.allowed) {
      this.$router.replace('/')
      return
    }
    await this.load()
  },
  methods: {
    onPeriodChange(range) {
      this.from = range.from
      this.to = range.to
      this.load()
    },
    usersQuery() {
      return new URLSearchParams({
        from: this.from,
        to: this.to,
        sort: this.sort,
        order: this.order,
        limit: '200',
      }).toString()
    },
    async load() {
      this.loading = true
      this.error = false
      this.partialErrorMessage = ''
      this.partialErrorRetryable = true
      // m-5②: 낡은 sync 결과 문구가 기간 변경·재조회 후에도 남아 다른 기간의 결과처럼 읽히는 것을
      // 막는다(syncGaps()는 이 load() 호출이 끝난 뒤 자기 메시지를 다시 설정하므로 안전하다).
      this.syncResultMessage = ''
      const [summaryRes, usersRes] = await Promise.all([
        useApi(`/api/admin/usage/summary?from=${this.from}&to=${this.to}`),
        useApi(`/api/admin/usage/users?${this.usersQuery()}`),
        this.loadRegistry(),
      ])
      this.loading = false
      this.summaryFailed = !!summaryRes.error
      this.usersFailed = !!usersRes.error
      if (summaryRes.error && usersRes.error) {
        this.error = true
        const info = usageErrorMessage(summaryRes.error || usersRes.error)
        this.errorMessage = info.message
        this.errorRetryable = info.retryable
        return
      }
      // 둘 중 하나만 실패한 경우: 성공한 쪽 데이터는 버리지 않고 그대로 보여주되(반환하지 않는다),
      // 실패 사실은 배너로 반드시 노출한다 — 조용히 0/빈 값으로 보이는 것을 막기 위함(M-3).
      if (summaryRes.error || usersRes.error) {
        const failedName = summaryRes.error ? '전사 요약(KPI/일별 그래프)' : '사용자별 목록'
        const info = usageErrorMessage(summaryRes.error || usersRes.error)
        this.partialErrorMessage = `${failedName} 데이터를 불러오지 못했습니다 — ${info.message} 나머지 데이터만 최신입니다.`
        this.partialErrorRetryable = info.retryable
      }
      this.summaryRows = summaryRes.error ? [] : (summaryRes.data?.data || [])
      this.meta = summaryRes.error ? null : (summaryRes.data?.meta || null)
      this.users = usersRes.error ? [] : (usersRes.data?.data || [])
      this.usersMeta = usersRes.error ? null : (usersRes.data?.meta || null)
    },
    // 공용 워크스테이션 레지스트리 목록(GET /api/admin/usage/shared-workstations, §5.9.9).
    // 실패해도 사용량 화면 전체를 막지 않는다 — 라벨·메모 표시와 관리 모달만 비고, 그 사실은
    // 관리 모달 안에서 알린다(사용량 수치 자체는 이 목록과 무관하게 서버가 이미 판정해 내려준다).
    async loadRegistry() {
      const { data, error } = await useApi('/api/admin/usage/shared-workstations')
      this.registryFailed = !!error
      this.registry = error ? [] : (data?.data || [])
    },
    // 관리자가 결손일(gap_days)을 Cron까지 기다리지 않고 즉시 채우는 수동 트리거(설계 §18.7 — 선택
    // 기능). 부분 성공도 200으로 온다 — committed_days가 있으면 그만큼은 실제로 채워진 것이다.
    //
    // C-1 — "실제로 채운 날이 있는가" / "채울 결손이 애초에 없었는가" / "설정이 안 돼 아무것도 못
    // 했는가"를 구분한다. 서버 응답(server/lib/usage-rollup.js)의 `skipped:'not_configured'`(상류
    // 설정 없음)·`no_progress`(대상은 있는데 청크를 하나도 시도 못함, 서버 예산 설정 결함 신호)를
    // 그냥 committed=0으로 뭉개면 "0일치를 적재했습니다. 결손이 모두 해소됐습니다"라는 거짓 성공이
    // 나온다(아무 일도 안 했는데 해결됐다고 보고하는 것 — 이 리스크 범주에서 가장 나쁜 형태).
    async syncGaps() {
      this.syncing = true
      // m-5④: 응답이 영영 안 오면 syncing이 영구 true가 돼 버튼이 죽는다(좀비 상태). 60초 후
      // 클라이언트에서 스스로 포기한다 — 공유 useApi()의 기본 동작은 바꾸지 않고 이 호출에만 적용.
      const timeout = new Promise((resolve) => {
        setTimeout(() => resolve({ data: null, error: { message: '응답을 받지 못했습니다(60초 초과).' } }), 60000)
      })
      const { data, error } = await Promise.race([useApi('/api/admin/usage/sync', { method: 'POST' }), timeout])
      this.syncing = false

      let message
      let variant
      if (error) {
        variant = 'danger'
        message = `롤업 적재에 실패했습니다${error?.message ? ` — ${error.message}` : ''}.`
      } else if (data?.skipped === 'not_configured') {
        variant = 'warning'
        message = '사용량 수집이 아직 설정되지 않아 적재하지 않았습니다(관리자 설정 필요 — 다시 눌러도 채워지지 않습니다).'
      } else if (data?.no_progress) {
        variant = 'danger'
        message = '적재를 시도조차 하지 못했습니다(서버 설정 문제로 추정) — 관리자에게 문의하세요.'
      } else {
        const committed = data?.committed_days?.length || 0
        const remaining = data?.remaining_gap_days?.length || 0
        if (committed === 0 && remaining === 0) {
          variant = 'secondary'
          message = '적재할 결손이 없습니다.'
        } else if (remaining > 0) {
          variant = 'warning'
          message = `${committed}일치를 적재했습니다. ${remaining}일치가 남아 있어 다시 눌러야 합니다${data?.budget_exhausted ? '(시간 예산 초과)' : ''}.`
        } else {
          variant = 'success'
          message = `${committed}일치를 적재했습니다. 결손이 모두 해소됐습니다.`
        }
      }
      // load()가 내부에서 syncResultMessage를 비우므로(m-5②), 반드시 load() 완료 뒤에 최종 문구를 설정한다.
      await this.load()
      this.syncResultMessage = message
      this.syncResultVariant = variant
    },
    // 정렬 기준만 바뀌면 사용자 목록만 다시 받는다(전사 KPI/차트는 기간에만 의존).
    async loadUsersOnly() {
      this.usersLoading = true
      this.partialErrorMessage = ''
      this.partialErrorRetryable = true
      const { data, error } = await useApi(`/api/admin/usage/users?${this.usersQuery()}`)
      this.usersLoading = false
      if (error) {
        // 재정렬 실패 시 직전 목록은 그대로 유지하되(빈 화면으로 튀지 않게), 실패 사실은 배너로
        // 알린다(M-3). usersFailed는 건드리지 않는다 — 화면에 남은 목록은 여전히 유효한 값이라
        // KPI를 '—'로 바꾸면 오히려 멀쩡한 값을 숨기게 된다.
        const info = usageErrorMessage(error)
        this.partialErrorMessage = `사용자별 목록을 다시 불러오지 못했습니다 — ${info.message} 이전 정렬 결과를 계속 표시합니다.`
        this.partialErrorRetryable = info.retryable
        return
      }
      this.users = data?.data || []
      this.usersMeta = data?.meta || null
    },
    setSort(key) {
      if (this.sort === key) {
        this.order = this.order === 'desc' ? 'asc' : 'desc'
      } else {
        this.sort = key
        this.order = key === 'name' ? 'asc' : 'desc'
      }
      this.loadUsersOnly()
    },
    sortIcon(key) {
      if (this.sort !== key) return 'bi-chevron-expand text-faint'
      return this.order === 'desc' ? 'bi-chevron-down' : 'bi-chevron-up'
    },
    // Prometheus-only 행(user_id === null)은 malgnai-hub 계정이 없어 드릴다운을 열 수 없다(§5.1).
    goToUser(u) {
      if (u.source === 'prometheus_only' || !u.user_id) return
      this.$router.push(`/usage/${u.user_id}`)
    },
    // 공용 워크스테이션 축(관측 행) 여부. identity_source만으로는 판정할 수 없다 —
    // docs/api.md §5.9.2가 명시하듯 서버는 **회원 행(d1_user)에도** 그 회원의 연동 값이 공용 축이면
    // identity_source='shared_workstation'을 싣는다(shared_workstation_conflict 상태,
    // server/lib/usage-prom.js 1차 루프). identity_source만 보면 실존 인물의 행이 "공용 PC"로
    // 배지·이름 격하되어 이 기능의 목적(누가 사람이고 무엇이 공용 PC인지 구별)을 정면으로 뒤집는다.
    // 공용 축 자체는 항상 관측 행(source='prometheus_only')이므로 두 조건을 함께 본다.
    // 회원 행은 여기서 false가 되고 shared_workstation_conflict 경고 경로로만 표현된다.
    isShared(u) {
      return u.source === 'prometheus_only' && u.identity_source === 'shared_workstation'
    },
    // §4.6 이름 일치 경고 문구(표시 전용 신호 — 분류·집계에 관여하지 않는다).
    nameMatchText(u) {
      const m = u.observed_name_matches_user
      if (!m) return ''
      return `관측 이름 '${u.observed_employee_name}'과 같은 이름의 회원(${m.email})이 이미 다른 축(${m.employee_id})에 연결돼 있습니다.`
    },
    registryEntry(employeeId) {
      return this.registry.find((r) => r.employee_id === employeeId) || null
    },
    registryNote(employeeId) {
      const e = this.registryEntry(employeeId)
      return e && e.note ? e.note : ''
    },
    // §7.3-B ② 미연결 관측치 연결 흐름.
    openConnect(row) {
      this.connectModal = { open: true, row, query: '', selectedUserId: null, submitting: false, error: '', conflict: null, sharedConflict: null }
    },
    closeConnect() {
      this.connectModal.open = false
    },
    async confirmConnect() {
      const { row, selectedUserId } = this.connectModal
      if (!selectedUserId) return
      const target = this.users.find((u) => u.user_id === selectedUserId && u.source === 'd1_user')
      // 선택한 사용자에게 이미 다른 값이 있으면 대체를 확인받는다(§7.3-B ② — 조용한 덮어쓰기 금지).
      if (target?.employee_id && target.employee_id !== row.employee_id) {
        if (!window.confirm(`선택한 사용자에게는 이미 연동 아이디 "${target.employee_id}"가 있습니다. "${row.employee_id}"로 대체할까요?`)) return
      }
      this.connectModal.submitting = true
      this.connectModal.error = ''
      this.connectModal.conflict = null
      this.connectModal.sharedConflict = null
      const { data, error } = await useApi(`/api/admin/users/${selectedUserId}/employee-id`, {
        method: 'PUT',
        body: { employee_id: row.employee_id },
      })
      this.connectModal.submitting = false
      if (error) {
        // 409 SHARED_WORKSTATION은 "먼저 공용 등록을 해제하라"는 전혀 다른 조치를 요구한다
        // (docs/api.md §5.9.6). 자동 해제 버튼은 만들지 않는다.
        if (error && error.code === 'SHARED_WORKSTATION') {
          this.connectModal.sharedConflict = (error.details && error.details.employee_id)
            ? error.details
            : { employee_id: row.employee_id, label: null, registered_at: null }
          // 이 축이 방금 공용으로 등록됐을 수 있으므로 레지스트리를 다시 읽어 화면 상태를 맞춘다.
          await this.loadRegistry()
          return
        }
        this.connectModal.error = (error && error.message) || '연결에 실패했습니다.'
        if (error && error.details && error.details.conflict_email) this.connectModal.conflict = error.details
        return
      }
      this.closeConnect()
      // 귀속이 바뀌면 다른 행의 수치도 함께 변하므로 반드시 재조회한다(§7.3-B ②).
      await this.load()
    },
    // ── 공용 워크스테이션 등록/편집/해제(docs/api.md §5.9.9) ──────────────────────────────
    // 경로 파라미터는 반드시 encodeURIComponent로 조립한다 — employee_id에는 '.'·'%'·'+' 등이
    // 허용되고(§5.9.9 형식 규칙), 리터럴 '%'는 URL에서 '%25'로 와야 서버의 퍼센트 디코드와 맞는다.
    sharedWorkstationUrl(employeeId) {
      return `/api/admin/usage/shared-workstations/${encodeURIComponent(employeeId)}`
    },
    // 편집(edit) 모드의 프리필은 서버가 준 행이 아니라 별도로 받은 this.registry에서 온다. 그
    // 목록을 못 읽은 상태로 모달을 열면 라벨·메모가 빈 값으로 채워지고, 그대로 저장하면 PUT이
    // {label:null, note:null}을 보내 기존 값을 전면 삭제한다(라벨 갱신은 무감사 결정이라 흔적도
    // 남지 않는다). 그래서 프리필 근거가 없으면 한 번 재조회하고, 그래도 없으면 모달을 열지
    // 않는다 — "비어 보이는 폼"이 곧 파괴적 저장 버튼이 되지 않게 한다(M-4).
    async openRegister(row, mode) {
      let entry = this.registryEntry(row.employee_id)
      if (mode === 'edit' && !entry) {
        await this.loadRegistry()
        entry = this.registryEntry(row.employee_id)
        if (!entry) {
          this.partialErrorMessage = this.registryFailed
            ? '공용 워크스테이션 목록을 불러오지 못해 라벨을 편집할 수 없습니다(빈 값으로 저장하면 기존 라벨·메모가 지워집니다). 잠시 후 다시 시도하세요.'
            : `이 축(${row.employee_id})의 공용 워크스테이션 등록 정보를 찾지 못했습니다. 목록을 새로고침한 뒤 다시 시도하세요.`
          this.partialErrorRetryable = true
          return
        }
      }
      this.registerModal = {
        open: true,
        mode,
        employeeId: row.employee_id,
        observedName: row.observed_employee_name || '',
        totalTokens: row.total_tokens || 0,
        costUsd: row.cost_usd || 0,
        label: (entry && entry.label) || '',
        note: (entry && entry.note) || '',
        submitting: false,
        error: '',
        conflict: null,
      }
    },
    closeRegister() {
      this.registerModal.open = false
    },
    async confirmRegister() {
      const { employeeId, label, note } = this.registerModal
      if (!employeeId) return
      this.registerModal.submitting = true
      this.registerModal.error = ''
      this.registerModal.conflict = null
      const { error } = await useApi(this.sharedWorkstationUrl(employeeId), {
        method: 'PUT',
        body: { label: label.trim() || null, note: note.trim() || null },
      })
      this.registerModal.submitting = false
      if (error) {
        this.registerModal.error = (error && error.message) || '공용 워크스테이션 등록에 실패했습니다.'
        // 역방향 가드(409 CONFLICT): 회원이 이미 이 값을 연동 아이디로 쓰고 있음 — 선해제 필요.
        if (error && error.details && error.details.conflict_email) this.registerModal.conflict = error.details
        return
      }
      this.closeRegister()
      // 등록/해제는 조회 시점 판정이라 재적재 없이 즉시 소급된다 — 목록을 다시 읽어 귀속 이동을 반영한다.
      await this.load()
    },
    async unregisterShared(employeeId) {
      if (!employeeId) return
      if (!window.confirm(`공용 워크스테이션 등록을 해제할까요?\n\n해제하면 "${employeeId}" 축은 다시 개인 축으로 취급되어 개인 계정에 연결할 수 있게 됩니다. 전사 총합은 변하지 않고 귀속만 이동합니다.`)) return
      this.registryBusyId = employeeId
      this.sharedManage.error = ''
      const { error } = await useApi(this.sharedWorkstationUrl(employeeId), { method: 'DELETE' })
      this.registryBusyId = null
      if (error) {
        const message = (error && error.message) || '등록 해제에 실패했습니다.'
        if (this.sharedManage.open) this.sharedManage.error = message
        else this.partialErrorMessage = `공용 워크스테이션 등록 해제에 실패했습니다 — ${message}`
        return
      }
      await this.load()
    },
    async openSharedManage() {
      this.sharedManage = { open: true, loading: true, error: '', editingId: null, form: { label: '', note: '' }, saving: false }
      await this.loadRegistry()
      this.sharedManage.loading = false
      if (this.registryFailed) this.sharedManage.error = '공용 워크스테이션 목록을 불러오지 못했습니다. 잠시 후 다시 열어보세요.'
    },
    closeSharedManage() {
      this.sharedManage.open = false
    },
    startRegistryEdit(entry) {
      this.sharedManage.editingId = entry.employee_id
      this.sharedManage.form = { label: entry.label || '', note: entry.note || '' }
    },
    async saveRegistryEdit(entry) {
      this.sharedManage.saving = true
      this.sharedManage.error = ''
      const { error } = await useApi(this.sharedWorkstationUrl(entry.employee_id), {
        method: 'PUT',
        body: { label: this.sharedManage.form.label.trim() || null, note: this.sharedManage.form.note.trim() || null },
      })
      this.sharedManage.saving = false
      if (error) {
        this.sharedManage.error = (error && error.message) || '저장에 실패했습니다.'
        return
      }
      this.sharedManage.editingId = null
      // 라벨은 목록 행의 표시 이름(name)이기도 하므로 사용량 목록까지 함께 다시 읽는다.
      await this.load()
    },
    formatTokens,
    formatCost,
    formatDate,
    userRoleMeta,
    userStatusMeta,
  },
}
</script>

<style>
.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
.sortable:hover { color: var(--color-brand); }
.usage-row--unlinked { cursor: default; opacity: 0.75; }
/* 공용 워크스테이션 축은 "미연결 관측"이라 흐리게 처리되지만, 오귀속 사고의 원인이 된 행이라
   왼쪽 굵은 마커로 목록에서 즉시 눈에 띄게 한다(색 하나에만 의존하지 않도록 배지·라벨 병기). */
.usage-row--shared { opacity: 1; box-shadow: inset 4px 0 0 0 var(--color-ink, #212529); }
/* 설명 문구가 길어 첫 열이 표 전체를 밀어내지 않도록 폭을 묶는다(전문은 title 툴팁·모달에서). */
.usage-cell-note { max-width: 460px; }
.usage-actions-cell { width: 1%; }
/* 레지스트리 모달의 메모가 길면 작업 버튼이 가로 스크롤 밖으로 밀린다 — 폭을 묶고 전문은 툴팁으로. */
.usage-registry-note { max-width: 380px; }
.usage-row--conflict { box-shadow: inset 4px 0 0 0 var(--bs-danger, #dc3545); }
.connect-candidate { cursor: pointer; border-bottom: 1px solid var(--color-hairline); }
.connect-candidate:last-child { border-bottom: none; }
.connect-candidate:hover { background: var(--color-brand-tint); }
.connect-candidate--selected { background: var(--color-brand-soft); }
</style>
