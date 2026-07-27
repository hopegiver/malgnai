<template>
  <div class="d-flex justify-content-center">
    <div class="pair-card card p-4 p-sm-5">
      <div class="text-center mb-4">
        <div class="pair-icon mb-3"><i class="bi bi-usb-plug"></i></div>
        <h1 class="h4 mb-1">기기 연결</h1>
        <p class="text-muted small mb-0">Claude Code 플러그인이 이 계정으로 malgnai-hub에 접근할 수 있도록 승인합니다.</p>
      </div>

      <!-- 코드 누락 -->
      <div v-if="!code" class="alert alert-warning small mb-0">
        <i class="bi bi-exclamation-triangle me-1"></i>페어링 코드가 없습니다. CLI에서 안내한 링크로 다시 접속해주세요.
      </div>

      <!-- 로딩 -->
      <div v-else-if="loading" class="text-center text-muted py-4">
        <span class="spinner-border spinner-border-sm me-2"></span>기기 정보를 확인하는 중...
      </div>

      <!-- 조회 에러 -->
      <div v-else-if="lookupError" class="alert alert-warning small mb-0">
        <i class="bi bi-exclamation-triangle me-1"></i>{{ lookupError }}
      </div>

      <!-- 승인 완료 -->
      <div v-else-if="approved" class="text-center py-3">
        <i class="bi bi-check-circle-fill text-success mb-3" style="font-size:2.5rem"></i>
        <div class="fw-semibold mb-1">기기가 연결되었습니다</div>
        <div class="text-muted small">터미널로 돌아가 이어서 진행하세요.</div>
      </div>

      <!-- 이미 승인/만료된 코드 -->
      <div v-else-if="pairing && pairing.status !== 'pending'" class="text-center py-3">
        <i class="bi bi-info-circle text-muted mb-3" style="font-size:2.5rem"></i>
        <div class="fw-semibold mb-1">{{ pairing.status === 'expired' ? '만료된 페어링 코드입니다' : '이미 처리된 코드입니다' }}</div>
        <div class="text-muted small">{{ pairing.status === 'expired' ? 'CLI에서 다시 시도해주세요.' : pairingStatusMeta(pairing.status).label }}</div>
      </div>

      <!-- 승인 확인 -->
      <template v-else-if="pairing">
        <div class="pair-device-box d-flex align-items-center gap-3 mb-4">
          <div class="pair-device-icon"><i class="bi bi-laptop"></i></div>
          <div class="min-w-0">
            <div class="fw-semibold text-truncate">{{ pairing.device_name || '이름 없는 기기' }}</div>
            <div class="text-faint small font-monospace">{{ code }}</div>
          </div>
        </div>
        <p class="text-muted small mb-4">
          이 기기가 발급받는 토큰은 <strong>내 프로젝트에 한해</strong> 작업 이력·결정·이슈를 기록하고 조회할 수 있습니다.
          내 기기가 아니라면 승인하지 마세요.
        </p>

        <div v-if="approveError" class="alert alert-danger py-2 small">{{ approveError }}</div>

        <div class="d-flex gap-2">
          <button type="button" class="btn btn-outline-secondary flex-grow-1" :disabled="approving" @click="$router.push('/')">취소</button>
          <button type="button" class="btn btn-primary flex-grow-1" :disabled="approving" @click="approve">
            <span v-if="approving" class="spinner-border spinner-border-sm me-2"></span>
            이 기기 승인
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script>
export default {
  title: '기기 연결 · malgnai-hub',
  data() {
    return {
      code: '',
      pairing: null,
      loading: true,
      lookupError: '',
      approving: false,
      approveError: '',
      approved: false,
    }
  },
  async mounted() {
    this.code = typeof this.$route.query.code === 'string' ? this.$route.query.code : ''
    if (!this.code) { this.loading = false; return }
    await this.lookupPairing()
  },
  methods: {
    async lookupPairing() {
      // 참고: docs/api.md §5.2 표에는 pair-approve만 실려 있지만, architecture.md §6.2 3단계가
      // "GET /api/devices/pair-status?code=..." 를 CLI 폴링용으로 명시한다. 승인 전 기기 이름을
      // 사람에게 보여줘야 하는 이 화면도 같은 엔드포인트를 재사용한다고 가정한다(문서화된 이름을
      // 그대로 사용 — 임의로 새 경로를 만들지 않음). 백엔드 확정 시 devops 통합 단계에서 검증 필요.
      this.loading = true
      this.lookupError = ''
      const { data, error } = await useApi(`/api/devices/pair-status?code=${encodeURIComponent(this.code)}`)
      this.loading = false
      if (error) {
        this.lookupError = error?.code === 'NOT_FOUND'
          ? '존재하지 않는 페어링 코드입니다.'
          : (error?.message || '페어링 정보를 불러오지 못했습니다.')
        return
      }
      this.pairing = data?.data ?? data
    },
    async approve() {
      this.approving = true
      this.approveError = ''
      const { data, error } = await useApi('/api/devices/pair-approve', {
        method: 'POST',
        body: { pairing_code: this.code },
      })
      this.approving = false
      if (error) {
        this.approveError = error?.message || '승인에 실패했습니다. 다시 시도해주세요.'
        return
      }
      this.approved = true
    },
    pairingStatusMeta,
  },
}
</script>

<style>
.pair-card { width: 100%; max-width: 440px; border-radius: var(--rounded-xl); box-shadow: var(--shadow-lg); }
.pair-icon {
  width: 52px; height: 52px; margin: 0 auto; border-radius: var(--rounded-full);
  background: var(--color-brand-soft); color: var(--color-brand);
  display: flex; align-items: center; justify-content: center; font-size: 1.5rem;
}
.pair-device-box {
  padding: 0.875rem 1rem; border-radius: var(--rounded-lg);
  background: var(--color-canvas-soft); border: 1px solid var(--color-hairline);
}
.pair-device-icon {
  width: 40px; height: 40px; flex-shrink: 0; border-radius: var(--rounded-md);
  background: var(--color-surface); border: 1px solid var(--color-hairline);
  display: flex; align-items: center; justify-content: center; font-size: 1.1rem; color: var(--color-ink-muted);
}
</style>
