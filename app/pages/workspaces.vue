<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
      <h1 class="mb-0">업무 대시보드</h1>
      <div class="d-flex align-items-center gap-2">
        <span class="badge" :class="autonomyEnabled ? 'bg-success' : 'bg-secondary'">
          <i :class="autonomyEnabled ? 'bi bi-broadcast' : 'bi bi-pause-circle'" class="me-1"></i>
          자율 {{ autonomyEnabled ? '가동중' : '정지' }}
        </span>
        <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="loading" @click="load">
          <i class="bi bi-arrow-clockwise me-1"></i>새로고침
        </button>
      </div>
    </div>

    <p class="text-muted mb-4">
      <strong>자율 운영 중인 프로젝트</strong>입니다. 각 프로젝트의 지정 에이전트가 주기(cadence)마다
      STATUS·목표를 읽고 스스로 판단·수행합니다. 자율을 켠 프로젝트만 여기 표시됩니다.
    </p>

    <!-- API 에러(화면 노출) -->
    <div v-if="error" class="alert alert-danger d-flex justify-content-between align-items-center" role="alert">
      <span><i class="bi bi-exclamation-triangle me-2"></i>{{ error }}</span>
      <button type="button" class="btn btn-sm btn-outline-danger" @click="load">다시 시도</button>
    </div>

    <div v-if="loading" class="text-muted py-5 text-center">
      <div class="spinner-border spinner-border-sm me-2" role="status"></div>불러오는 중…
    </div>

    <div v-else-if="!workspaces.length" class="text-center text-muted py-5">
      <i class="bi bi-briefcase d-block mb-2" style="font-size: 2rem;"></i>
      아직 자율 운영 중인 프로젝트가 없습니다.
      <div class="small text-faint mt-1">프로젝트 상세 → <strong>자율 설정</strong>에서 관찰 LEAD·주기를 지정하고 자율을 켜면 여기에 나타납니다.</div>
    </div>

    <!-- 토글 알림 -->
    <div v-if="toast" class="alert alert-info py-2 d-flex justify-content-between align-items-center" role="status">
      <span><i class="bi bi-info-circle me-2"></i>{{ toast }}</span>
      <button type="button" class="btn-close" aria-label="닫기" @click="toast = ''"></button>
    </div>

    <div v-if="!loading && workspaces.length" class="row g-3">
      <div v-for="w in workspaces" :key="w.id" class="col-12 col-lg-6">
        <div class="card p-3 h-100 ws-card">
          <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
            <router-link :to="`/projects/${w.id}`" class="text-decoration-none" style="min-width: 0;">
              <div class="ws-name">{{ w.name }}</div>
              <div class="small text-muted">
                <i class="bi bi-robot me-1"></i>{{ w.lead_agent_name || 'LEAD 미지정' }}
                <span v-if="w.autonomy_level" class="ms-2 badge bg-light text-dark">{{ w.autonomy_level }}</span>
                <span v-if="w.cadence" class="ms-1 badge bg-light text-dark">{{ cadenceLabel(w.cadence) }}</span>
              </div>
            </router-link>
            <span class="badge flex-shrink-0" :class="isAutoOn(w) ? 'bg-success' : 'bg-secondary'">
              <i :class="isAutoOn(w) ? 'bi bi-broadcast' : 'bi bi-pause-circle'" class="me-1"></i>
              {{ isAutoOn(w) ? '자율 ON' : '자율 OFF' }}
            </span>
          </div>

          <router-link :to="`/projects/${w.id}`" class="text-decoration-none">
            <p v-if="w.goal" class="ws-goal pd-clamp-2 mb-3" :title="w.goal">
              <i class="bi bi-flag me-1 text-primary"></i>{{ w.goal }}
            </p>

            <!-- 핵심 지표(kpi_json) -->
            <div v-if="kpiList(w).length" class="ws-kpis mb-3">
              <span v-for="k in kpiList(w)" :key="k.code" class="ws-kpi">
                <span class="ws-kpi-code">{{ k.code }}</span>
                <span class="ws-kpi-target">목표 {{ k.target }}{{ k.unit ? ' ' + k.unit : '' }}</span>
              </span>
            </div>

            <!-- 태스크 집계 + 열린 이슈 -->
            <div class="d-flex flex-wrap gap-2 mb-3">
              <span class="ws-pill"><span class="ws-pill-dot bg-secondary"></span>대기 {{ w.tasks.pending }}</span>
              <span class="ws-pill"><span class="ws-pill-dot bg-info"></span>진행 {{ w.tasks.in_progress }}</span>
              <span class="ws-pill"><span class="ws-pill-dot bg-success"></span>완료 {{ w.tasks.done }}</span>
              <span v-if="w.tasks.failed" class="ws-pill"><span class="ws-pill-dot bg-danger"></span>실패 {{ w.tasks.failed }}</span>
              <span class="ws-pill" :class="{ 'ws-pill--warn': w.open_issues > 0 }">
                <i class="bi bi-exclamation-triangle me-1"></i>열린 이슈 {{ w.open_issues }}
              </span>
            </div>
          </router-link>

          <!-- 빠른 자율 토글 -->
          <div class="d-flex align-items-center justify-content-between gap-2 mt-auto pt-2 border-top border-hairline">
            <span class="small text-muted"><i class="bi bi-lightning-charge me-1"></i>빠른 전환</span>
            <div class="d-flex gap-2">
              <router-link :to="`/projects/${w.id}?tab=autonomy`" class="btn btn-sm btn-outline-secondary">
                <i class="bi bi-sliders me-1"></i>설정
              </router-link>
              <button type="button" class="btn btn-sm"
                :class="isAutoOn(w) ? 'btn-outline-danger' : 'btn-outline-success'"
                :disabled="togglingId === w.id"
                @click="quickToggle(w)">
                <span v-if="togglingId === w.id" class="spinner-border spinner-border-sm"></span>
                <template v-else>
                  <i :class="isAutoOn(w) ? 'bi bi-power me-1' : 'bi bi-play-fill me-1'"></i>
                  {{ isAutoOn(w) ? '끄기' : '켜기' }}
                </template>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 켜기 확인 다이얼로그 -->
    <div v-if="confirm.open" class="ws-modal-overlay" @click.self="closeConfirm">
      <div class="card ws-modal p-4" role="dialog" aria-modal="true" aria-labelledby="wsConfirmTitle">
        <h5 id="wsConfirmTitle" class="mb-2">
          <i :class="confirm.target ? 'bi bi-play-fill text-success' : 'bi bi-power text-danger'" class="me-2"></i>
          {{ confirm.target ? '자율을 켤까요?' : '자율을 끌까요?' }}
        </h5>
        <p class="text-muted mb-4">
          <strong>{{ confirm.name }}</strong>
          <template v-if="confirm.target"> 업무의 자율을 켭니다. LEAD 가 심장박동마다 스스로 할 일을 판단·배정합니다.</template>
          <template v-else> 업무의 자율을 끕니다. 새 자동 배정이 멈춥니다.</template>
        </p>
        <div class="d-flex justify-content-end gap-2">
          <button type="button" class="btn btn-outline-secondary" :disabled="!!togglingId" @click="closeConfirm">취소</button>
          <button type="button" ref="wsConfirmBtn" class="btn"
            :class="confirm.target ? 'btn-success' : 'btn-danger'"
            :disabled="!!togglingId" @click="applyConfirm">
            <span v-if="togglingId" class="spinner-border spinner-border-sm me-2"></span>
            {{ confirm.target ? '켜기' : '끄기' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: '업무 대시보드',
  data() {
    return {
      workspaces: [],
      autonomyEnabled: false,
      loading: false,
      error: '',
      togglingId: null,
      toast: '',
      toastTimer: null,
      confirm: { open: false, target: false, id: null, name: '' },
    }
  },
  async mounted() {
    await this.load()
  },
  beforeUnmount() {
    if (this.toastTimer) clearTimeout(this.toastTimer)
  },
  methods: {
    async load() {
      this.loading = true
      this.error = ''
      const { data, error } = await useApi('/api/projects/workspaces')
      this.loading = false
      if (error) {
        this.error = `업무 목록을 불러오지 못했습니다: ${error}`
        this.workspaces = []
        return
      }
      this.workspaces = data.workspaces || []
      this.autonomyEnabled = !!data.autonomy_enabled
    },
    // 프로젝트별 effective 자율 ON — 서버 isProjectAutonomyOn 과 동일 기준.
    isAutoOn(w) {
      const flag = w.autonomy_enabled
      const on = flag === '1' || flag === 'true' || flag === 'on' || flag === 1 || flag === true
      if (!on) return false
      if (w.cadence && String(w.cadence).toLowerCase() === 'off') return false
      if (!w.lead_agent_name) return false
      return true
    },
    cadenceLabel(c) {
      return { every15m: '15분마다', every30m: '30분마다', daily: '매일', hourly: '매시', every3h: '3시간마다', every6h: '6시간마다', every12h: '12시간마다', weekly: '매주', off: '주기 끔' }[c] || c
    },
    // 끄기는 즉시(확인). 켜기는 목표·LEAD 있으면 확인 후 즉시, 없으면 상세로 유도.
    quickToggle(w) {
      if (this.isAutoOn(w)) {
        this.openConfirm(false, w)
        return
      }
      // 켜기: 목표·LEAD 필요.
      if (!w.goal || !w.lead_agent_name) {
        this.showToast('자율을 켜려면 목표와 관찰 LEAD 를 먼저 설정하세요. 설정 화면으로 이동합니다.')
        this.$router.push(`/projects/${w.id}?tab=autonomy`)
        return
      }
      this.openConfirm(true, w)
    },
    openConfirm(target, w) {
      this.confirm = { open: true, target, id: w.id, name: w.name }
      this.$nextTick(() => { this.$refs.wsConfirmBtn?.focus() })
    },
    closeConfirm() {
      if (this.togglingId) return
      this.confirm.open = false
    },
    async applyConfirm() {
      const { target, id } = this.confirm
      this.togglingId = id
      const { data, error } = await useApi(`/api/projects/${id}/autonomy`, {
        method: 'PUT', body: { autonomy_enabled: target }
      })
      this.togglingId = null
      this.confirm.open = false
      if (error) {
        const e = String(error)
        this.showToast(
          e.includes('requires a lead_agent_name')
            ? '자율을 켜려면 관찰 LEAD 를 먼저 지정하세요(설정 화면).'
            : (e.includes('401') ? '로그인이 필요합니다.' : `자율 전환 실패: ${e}`)
        )
        return
      }
      // 반영: 해당 카드의 자율 필드 갱신.
      if (data && data.autonomy) {
        const idx = this.workspaces.findIndex(w => w.id === id)
        if (idx !== -1) {
          this.workspaces[idx] = {
            ...this.workspaces[idx],
            autonomy_enabled: data.autonomy.autonomy_enabled_raw,
            cadence: data.autonomy.cadence,
            lead_agent_name: data.autonomy.lead_agent_name,
          }
        }
        this.showToast(target ? '자율을 켰습니다.' : '자율을 껐습니다.')
      }
    },
    showToast(msg) {
      this.toast = msg
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toastTimer = setTimeout(() => { this.toast = '' }, 4000)
    },
    // kpi_json(문자열|객체) → [{ code, target, unit }] 배열. 파싱 실패는 빈 배열(빈 상태 처리).
    kpiList(w) {
      const raw = w.kpi_json
      if (!raw) return []
      let obj
      try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
      if (!obj || typeof obj !== 'object') return []
      return Object.entries(obj).map(([code, v]) => ({
        code,
        target: (v && typeof v === 'object' && v.target != null) ? v.target : (typeof v !== 'object' ? v : ''),
        unit: (v && typeof v === 'object' && v.unit) ? v.unit : '',
      }))
    },
  },
}
</script>

<style>
/* 업무 대시보드 전용(ws- 프리픽스 격리, scoped 금지 준수) */
.ws-card { transition: box-shadow 0.15s, transform 0.15s; border: 1px solid var(--color-hairline); }
.ws-card:hover { box-shadow: var(--shadow-soft, 0 4px 16px rgba(0,0,0,0.08)); transform: translateY(-2px); }
.ws-name { font-size: 1.0625rem; font-weight: 700; color: var(--color-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-goal { font-size: 0.875rem; color: var(--color-ink-secondary); line-height: 1.5; }

.ws-kpis { display: flex; flex-wrap: wrap; gap: 0.375rem; }
.ws-kpi {
  display: inline-flex; align-items: baseline; gap: 0.375rem;
  padding: 0.25rem 0.5rem; border-radius: var(--rounded-sm);
  background: var(--color-canvas-soft); font-size: 0.75rem;
}
.ws-kpi-code { font-weight: 600; color: var(--color-ink); }
.ws-kpi-target { color: var(--color-ink-muted); }

.ws-pill {
  display: inline-flex; align-items: center; gap: 0.375rem;
  font-size: 0.75rem; color: var(--color-ink-muted);
  padding: 0.2rem 0.5rem; border-radius: var(--rounded-full);
  background: var(--color-canvas-soft);
}
.ws-pill--warn { color: var(--color-accent-orange); background: rgba(221,91,0,0.1); }
.ws-pill-dot { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: var(--rounded-full); }

.ws-modal-overlay {
  position: fixed; inset: 0; z-index: 1050;
  background: rgba(0,0,0,0.45);
  display: flex; align-items: center; justify-content: center; padding: 1rem;
}
.ws-modal { width: 100%; max-width: 30rem; box-shadow: var(--shadow-soft, 0 8px 32px rgba(0,0,0,0.18)); }

@media (prefers-reduced-motion: reduce) {
  .ws-card:hover { transform: none; }
}
</style>
