<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
      <h1 class="mb-0">자율 제어판</h1>
      <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="loading" @click="load">
        <i class="bi bi-arrow-clockwise me-1"></i>새로고침
      </button>
    </div>

    <!-- API 에러(화면 노출 — 삼키지 않음) -->
    <div v-if="error" class="alert alert-danger d-flex justify-content-between align-items-center" role="alert">
      <span><i class="bi bi-exclamation-triangle me-2"></i>{{ error }}</span>
      <button type="button" class="btn btn-sm btn-outline-danger" @click="load">다시 시도</button>
    </div>

    <!-- 일시 안내 배너(토글 성공 등) -->
    <div v-if="toast" class="alert alert-info py-2 d-flex justify-content-between align-items-center" role="status">
      <span><i class="bi bi-info-circle me-2"></i>{{ toast }}</span>
      <button type="button" class="btn-close" aria-label="닫기" @click="toast = ''"></button>
    </div>

    <div v-if="loading && !status" class="text-muted py-5 text-center">
      <div class="spinner-border spinner-border-sm me-2" role="status"></div>불러오는 중…
    </div>

    <template v-else-if="status">
      <!-- 마스터 kill-switch -->
      <div class="card p-4 mb-4 auto-switch" :class="autonomyOn ? 'auto-switch--on' : 'auto-switch--off'">
        <div class="d-flex align-items-center gap-3 flex-wrap">
          <div class="auto-switch-icon" :class="autonomyOn ? 'text-success' : 'text-muted'">
            <i :class="autonomyOn ? 'bi bi-broadcast' : 'bi bi-pause-circle'"></i>
          </div>
          <div class="flex-grow-1" style="min-width: 0;">
            <div class="auto-switch-state" :class="autonomyOn ? 'text-success' : 'text-ink-muted'">
              {{ autonomyOn ? '자율 가동 중' : '자율 정지' }}
            </div>
            <div class="small text-muted">
              {{ autonomyOn
                ? '각 프로젝트의 지정 에이전트가 심장박동마다 스스로 업무를 판단·수행합니다.'
                : '모든 자율 배정이 승인 대기로 강등됩니다(실행·비용 0).' }}
              <template v-if="status.autonomy.updated_at">
                · 마지막 변경 {{ fmt(status.autonomy.updated_at) }}
              </template>
            </div>
          </div>
          <button
            type="button"
            class="btn btn-lg auto-switch-btn"
            :class="autonomyOn ? 'btn-danger' : 'btn-success'"
            :disabled="toggling"
            @click="openConfirm(!autonomyOn)">
            <span v-if="toggling" class="spinner-border spinner-border-sm me-2"></span>
            <i v-else :class="autonomyOn ? 'bi bi-power me-2' : 'bi bi-play-fill me-2'"></i>
            {{ autonomyOn ? '자율 정지하기' : '자율 가동하기' }}
          </button>
        </div>
      </div>

      <!-- 현황 카드 4종 -->
      <div class="row g-3 mb-2">
        <!-- ① 오늘 자율 비용 vs 예산 -->
        <div class="col-12 col-md-6 col-xl-3">
          <div class="card p-3 h-100 pd-stat" :class="costDanger ? 'pd-stat--danger' : 'pd-stat--primary'">
            <div class="pd-stat-top">
              <span class="pd-stat-icon"><i class="bi bi-cash-coin"></i></span>
              <span class="pd-stat-label">오늘 자율 비용</span>
            </div>
            <div class="pd-stat-value">${{ (status.cost?.today_usd ?? 0).toFixed(2) }}</div>
            <div class="pd-stat-sub">하루 예산 ${{ (status.cost?.daily_limit_usd ?? 0).toFixed(2) }} · {{ status.cost?.pct ?? 0 }}% 사용</div>
            <div class="pd-progress-track mt-2">
              <div class="pd-progress-fill"
                   :style="{ width: status.cost.pct + '%', background: costDanger ? '#c12c39' : 'var(--color-primary)' }"></div>
            </div>
          </div>
        </div>

        <!-- ② 실행 중 워커 -->
        <div class="col-12 col-md-6 col-xl-3">
          <div class="card p-3 h-100 pd-stat pd-stat--info">
            <div class="pd-stat-top">
              <span class="pd-stat-icon"><i class="bi bi-cpu"></i></span>
              <span class="pd-stat-label">실행 중 워커</span>
            </div>
            <div class="pd-stat-value">{{ status.workers?.running ?? 0 }}</div>
            <div class="pd-stat-sub">claimed · running 상태</div>
          </div>
        </div>

        <!-- ③ 승인 대기 태스크 -->
        <div class="col-12 col-md-6 col-xl-3">
          <router-link to="/approvals" class="text-decoration-none">
            <div class="card p-3 h-100 pd-stat"
                 :class="(status.approvals?.pending ?? 0) ? 'pd-stat--warning' : 'pd-stat--neutral'">
              <div class="pd-stat-top">
                <span class="pd-stat-icon"><i class="bi bi-inbox"></i></span>
                <span class="pd-stat-label">승인 대기 태스크</span>
              </div>
              <div class="pd-stat-value">{{ status.approvals?.pending ?? 0 }}</div>
              <div class="pd-stat-sub">
                LEAD 생성 대기 <i class="bi bi-arrow-right-short"></i>승인대기함
              </div>
            </div>
          </router-link>
        </div>

        <!-- ④ 최근 자율 사이클 -->
        <div class="col-12 col-md-6 col-xl-3">
          <div class="card p-3 h-100 pd-stat" :class="cycleStatClass">
            <div class="pd-stat-top">
              <span class="pd-stat-icon"><i class="bi bi-arrow-repeat"></i></span>
              <span class="pd-stat-label">최근 자율 사이클</span>
            </div>
            <template v-if="status.last_cycle?.status">
              <div class="pd-stat-value" style="font-size: 1.25rem;">
                <span :class="'badge bg-' + cycleColor(status.last_cycle.status)">
                  {{ cycleLabel(status.last_cycle.status) }}
                </span>
              </div>
              <div class="pd-stat-sub">
                {{ fmt(status.last_cycle.created_at) }}
                <template v-if="status.last_cycle.cost_usd != null"> · ${{ (status.last_cycle.cost_usd || 0).toFixed(2) }}</template>
              </div>
              <div v-if="status.last_cycle.error" class="small text-danger mt-1 pd-clamp-2" :title="status.last_cycle.error">
                <i class="bi bi-exclamation-circle me-1"></i>{{ status.last_cycle.error }}
              </div>
            </template>
            <template v-else>
              <div class="pd-stat-value" style="font-size: 1.25rem;">—</div>
              <div class="pd-stat-sub">아직 실행된 사이클이 없습니다.</div>
            </template>
          </div>
        </div>
      </div>

      <p class="small text-faint mt-3">
        <i class="bi bi-shield-lock me-1"></i>
        자율 스위치는 kill-switch 입니다. 끄면 다음 박동부터 모든 자율 배정이 즉시 승인 대기로 강등됩니다.
      </p>

      <!-- 프로젝트별 자율 상태 (자율 ON 프로젝트만 — OFF/켜기·끄기는 프로젝트 상세에서) -->
      <template v-if="status.projects && status.projects.length">
        <div class="d-flex justify-content-between align-items-center mt-4 mb-3">
          <h2 class="h6 mb-0"><i class="bi bi-diagram-3 me-1"></i>자율 가동 중인 프로젝트</h2>
          <span class="text-faint small">켜기·끄기는 프로젝트 상세에서</span>
        </div>
        <div class="row g-3">
          <div class="col-12 col-md-6 col-xl-4" v-for="p in status.projects" :key="p.id">
            <div class="pa-card card h-100" style="cursor:pointer" @click="$router.push('/projects/' + p.id)">
              <div class="d-flex justify-content-between align-items-start mb-2">
                <span class="fw-semibold text-truncate me-2">{{ p.name }}</span>
                <span v-if="p.pending_approvals > 0" class="badge bg-warning text-dark flex-shrink-0">승인대기 {{ p.pending_approvals }}</span>
              </div>
              <div class="d-flex align-items-center gap-2 mb-3">
                <span class="badge bg-secondary-subtle text-secondary-emphasis">{{ projectStatusLabel(p.status) }}</span>
                <span v-if="p.last_cycle_status" :class="'badge bg-' + cycleColor(p.last_cycle_status)">{{ cycleLabel(p.last_cycle_status) }}</span>
              </div>
              <div class="pa-card-grid">
                <div>
                  <div class="text-faint" style="font-size:11px">오늘 비용</div>
                  <div class="small">{{ p.cost_today_usd != null ? '$' + p.cost_today_usd.toFixed(2) : '—' }}</div>
                </div>
                <div>
                  <div class="text-faint" style="font-size:11px">실패율(7일)</div>
                  <div class="small" :class="failureRateDanger(p) ? 'text-danger fw-semibold' : ''">
                    {{ p.cycles_total ? failureRateLabel(p) : '표본없음' }}
                  </div>
                </div>
                <div>
                  <div class="text-faint" style="font-size:11px">다음 실행</div>
                  <div class="small">{{ p.next_run_at ? relativeTime(p.next_run_at) : '—' }}</div>
                </div>
                <div>
                  <div class="text-faint" style="font-size:11px">마지막 실행</div>
                  <div class="small">{{ p.last_run_at ? relativeTime(p.last_run_at) : '—' }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
      <div v-else-if="status.projects && !status.projects.length" class="card p-4 mt-4">
        <p class="text-muted mb-0 small"><i class="bi bi-diagram-3 me-1"></i>자율 가동 중인 프로젝트가 없습니다. 프로젝트 상세에서 자율을 켜면 여기 표시됩니다.</p>
      </div>

      <!-- 엔진 설정(engine.* — app_settings DB화, 편집은 관리자만) -->
      <div class="card p-4 mt-4">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h2 class="h6 mb-0"><i class="bi bi-sliders me-1"></i>엔진 설정</h2>
          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="settingsLoading" @click="loadEngineSettings">
            <i class="bi bi-arrow-clockwise me-1"></i>새로고침
          </button>
        </div>
        <p class="small text-muted mb-3">
          <code>com.malgnai.engine</code> 튜닝값입니다. 코드 재배포 없이 여기서 바로 반영됩니다(<code>app_settings</code> 저장).
          <span v-if="!admin">읽기 전용 — 수정은 최고관리자만 가능합니다.</span>
        </p>
        <div v-if="settingsError" class="alert alert-danger py-2 small">{{ settingsError }}</div>
        <div v-if="settingsLoading && !engineSettings.length" class="text-muted small py-2">불러오는 중…</div>
        <div v-else class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead class="table-light">
              <tr>
                <th style="min-width:12rem">설정</th>
                <th style="min-width:8rem">값</th>
                <th class="d-none d-md-table-cell">설명</th>
                <th v-if="admin" style="width:5rem"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in engineSettings" :key="s.key">
                <td>
                  <div class="fw-medium">{{ s.label }}</div>
                  <div class="small text-faint">{{ s.key }}</div>
                </td>
                <td>
                  <template v-if="s.type === 'bool'">
                    <select class="form-select form-select-sm" v-model="draft[s.key]" :disabled="!admin || saving[s.key]">
                      <option value="1">ON</option>
                      <option value="0">OFF</option>
                    </select>
                  </template>
                  <template v-else>
                    <input type="number" class="form-control form-control-sm" v-model="draft[s.key]"
                           :disabled="!admin || saving[s.key]">
                  </template>
                </td>
                <td class="d-none d-md-table-cell small text-muted">{{ s.description }}</td>
                <td v-if="admin">
                  <button type="button" class="btn btn-sm btn-primary"
                          :disabled="saving[s.key] || draft[s.key] === s.value"
                          @click="saveEngineSetting(s)">
                    <span v-if="saving[s.key]" class="spinner-border spinner-border-sm"></span>
                    <span v-else>저장</span>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 확인 다이얼로그(끄기/켜기 모두) — bootstrap.Modal 대신 v-if 플래그 + 오버레이 -->
    <div v-if="confirm.open" class="auto-modal-overlay" @click.self="closeConfirm">
      <div class="card auto-modal p-4" role="dialog" aria-modal="true" aria-labelledby="autoConfirmTitle">
        <h5 id="autoConfirmTitle" class="mb-2">
          <i :class="confirm.target ? 'bi bi-play-fill text-success' : 'bi bi-power text-danger'" class="me-2"></i>
          {{ confirm.target ? '자율 운영을 가동할까요?' : '자율 운영을 정지할까요?' }}
        </h5>
        <p class="text-muted mb-4">
          <template v-if="confirm.target">
            각 프로젝트의 지정 에이전트가 심장박동마다 스스로 업무를 판단하고 수행합니다.
            예산·승인 게이트 안에서만 동작하지만, 자율 실행이 시작됩니다.
          </template>
          <template v-else>
            모든 자율 배정이 즉시 승인 대기로 강등되어 실행과 비용이 멈춥니다.
            진행 중인 사이클은 이후 배정을 만들지 않습니다.
          </template>
        </p>
        <div class="d-flex justify-content-end gap-2">
          <button type="button" class="btn btn-outline-secondary" :disabled="toggling" @click="closeConfirm">취소</button>
          <button type="button" ref="confirmBtn"
                  class="btn" :class="confirm.target ? 'btn-success' : 'btn-danger'"
                  :disabled="toggling" @click="applyToggle">
            <span v-if="toggling" class="spinner-border spinner-border-sm me-2"></span>
            {{ confirm.target ? '가동' : '정지' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: '자율 제어판',
  data() {
    return {
      status: null,
      loading: false,
      toggling: false,
      error: '',
      toast: '',
      toastTimer: null,
      confirm: { open: false, target: false },
      admin: isSuperAdmin(),
      engineSettings: [],
      draft: {},
      saving: {},
      settingsLoading: false,
      settingsError: '',
    }
  },
  computed: {
    autonomyOn() {
      return !!this.status?.autonomy?.enabled
    },
    costDanger() {
      return this.status ? this.status.cost.pct >= 80 : false
    },
    cycleStatClass() {
      const s = this.status?.last_cycle?.status
      if (s === 'failed') return 'pd-stat--danger'
      if (s === 'done') return 'pd-stat--success'
      if (s === 'running' || s === 'claimed') return 'pd-stat--info'
      return 'pd-stat--neutral'
    },
  },
  async mounted() {
    await this.load()
    await this.loadEngineSettings()
  },
  beforeUnmount() {
    if (this.toastTimer) clearTimeout(this.toastTimer)
  },
  methods: {
    async load() {
      this.loading = true
      this.error = ''
      const { data, error } = await useApi('/api/lead/status')
      this.loading = false
      if (error) {
        this.error = `현황을 불러오지 못했습니다: ${error}`
        return
      }
      this.status = data
    },
    openConfirm(target) {
      this.confirm = { open: true, target }
      this.$nextTick(() => { this.$refs.confirmBtn?.focus() })
    },
    closeConfirm() {
      if (this.toggling) return
      this.confirm.open = false
    },
    async applyToggle() {
      const target = this.confirm.target
      this.toggling = true
      const { data, error } = await useApi('/api/lead/autonomy', {
        method: 'PUT',
        body: { enabled: target },
      })
      this.toggling = false
      this.confirm.open = false
      if (error) {
        this.showToast(`자율 상태 변경에 실패했습니다: ${error}`)
        return
      }
      // 낙관 반영 + 서버 최신 현황 재조회.
      if (this.status) this.status.autonomy.enabled = data.enabled
      this.showToast(data.enabled ? '자율 운영을 가동했습니다.' : '자율 운영을 정지했습니다.')
      await this.load()
    },
    showToast(msg) {
      this.toast = msg
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toastTimer = setTimeout(() => { this.toast = '' }, 4000)
    },
    cycleColor(s) {
      return { done: 'success', failed: 'danger', running: 'info', claimed: 'info', queued: 'secondary', approved: 'primary' }[s] || 'secondary'
    },
    cycleLabel(s) {
      return { done: '완료', failed: '실패', running: '실행 중', claimed: '실행 중', queued: '대기', approved: '승인됨', rejected: '반려', expired: '만료' }[s] || s || '—'
    },
    failureRatePct(p) {
      if (!p.cycles_total) return 0
      return (p.cycles_failed / p.cycles_total) * 100
    },
    failureRateLabel(p) {
      return this.failureRatePct(p).toFixed(1) + '%'
    },
    failureRateDanger(p) {
      return this.failureRatePct(p) >= 20
    },
    fmt(s) {
      return s ? new Date(s).toLocaleString('ko-KR') : ''
    },
    projectStatusLabel(s) {
      return { planning: '기획', design: '설계', development: '개발', testing: '테스트', active: '진행', paused: '중단', done: '완료', archived: '보관' }[s] || s || '진행'
    },
    relativeTime(iso) {
      if (!iso) return ''
      const diff = Date.now() - new Date(iso).getTime()
      const abs = Math.abs(diff)
      const min = Math.floor(abs / 60000)
      const future = diff < 0
      if (min < 1) return '지금'
      if (min < 60) return min + '분 ' + (future ? '후' : '전')
      const hr = Math.floor(min / 60)
      if (hr < 24) return hr + '시간 ' + (future ? '후' : '전')
      return Math.floor(hr / 24) + '일 ' + (future ? '후' : '전')
    },
    async loadEngineSettings() {
      this.settingsLoading = true
      this.settingsError = ''
      const { data, error } = await useApi('/api/lead/engine-settings')
      this.settingsLoading = false
      if (error) {
        this.settingsError = `엔진 설정을 불러오지 못했습니다: ${error}`
        return
      }
      this.engineSettings = data.settings || []
      const draft = {}
      this.engineSettings.forEach(s => { draft[s.key] = s.value })
      this.draft = draft
    },
    async saveEngineSetting(s) {
      this.saving = { ...this.saving, [s.key]: true }
      const { data, error } = await useApi('/api/lead/engine-settings', {
        method: 'PUT',
        body: { key: s.key, value: this.draft[s.key] },
      })
      this.saving = { ...this.saving, [s.key]: false }
      if (error) {
        this.showToast(`${s.label} 저장 실패: ${error}`)
        return
      }
      s.value = data.value
      s.updated_at = data.updated_at
      this.showToast(`${s.label}을(를) ${data.value}(으)로 저장했습니다.`)
    },
  },
}
</script>

<style>
/* 자율 제어판 전용 — vue-zero scoped 금지라 전역이나 페이지 고유 프리픽스(auto-)로 격리 */
.auto-switch { border-width: 1px; transition: border-color 0.2s, background-color 0.2s; }
.auto-switch--on { border-left: 4px solid var(--color-accent-green); background: rgba(26,174,57,0.04); }
.auto-switch--off { border-left: 4px solid var(--color-ink-faint); }
.auto-switch-icon { font-size: 2.5rem; line-height: 1; flex-shrink: 0; }
.auto-switch-state { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02rem; }
.text-ink-muted { color: var(--color-ink-muted); }
.auto-switch-btn { min-width: 10.5rem; font-weight: 600; }

.auto-modal-overlay {
  position: fixed; inset: 0; z-index: 1050;
  background: rgba(0,0,0,0.45);
  display: flex; align-items: center; justify-content: center; padding: 1rem;
}
.auto-modal { width: 100%; max-width: 30rem; box-shadow: var(--shadow-soft, 0 8px 32px rgba(0,0,0,0.18)); }

.pa-card { padding: 1rem; transition: box-shadow 0.15s, border-color 0.15s; }
.pa-card:hover { border-color: var(--color-primary); box-shadow: var(--shadow-soft, 0 4px 16px rgba(0,0,0,0.08)); }
.pa-card-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem 1rem; }

@media (max-width: 575.98px) {
  .auto-switch-btn { width: 100%; }
  .auto-switch-state { font-size: 1.25rem; }
}
</style>
