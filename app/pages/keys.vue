<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
      <div>
        <h1 class="mb-0">인증키 관리</h1>
        <small class="text-muted" v-if="!loading && !error">내 기기 {{ devices.length }}개</small>
      </div>
      <div class="d-flex align-items-center gap-2">
        <button class="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1" @click="load" :disabled="loading">
          <i class="bi" :class="loading ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'"></i>
          새로고침
        </button>
        <button class="btn btn-primary btn-sm d-flex align-items-center gap-1" @click="openIssueModal">
          <i class="bi bi-plus-lg"></i>
          새 인증키 발급
        </button>
      </div>
    </div>

    <!-- 로딩 -->
    <div v-if="loading" class="card p-4 placeholder-glow">
      <span class="placeholder col-12 mb-2" style="height:2rem"></span>
      <span class="placeholder col-12" style="height:2rem"></span>
    </div>

    <!-- 에러 -->
    <div v-else-if="error" class="alert alert-warning d-flex justify-content-between align-items-center">
      <span><i class="bi bi-exclamation-triangle me-1"></i>{{ errorMessage }}</span>
      <button class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
    </div>

    <!-- 빈 상태 -->
    <div v-else-if="!devices.length" class="text-center py-5">
      <i class="bi bi-key d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
      <div class="fw-medium mb-1 text-muted">발급된 인증키가 없습니다</div>
      <div class="text-faint small">Claude Code 플러그인이 malgnai-hub MCP에 접근하려면 인증키가 필요합니다.</div>
    </div>

    <!-- 목록 -->
    <div v-else class="card p-0">
      <div class="table-responsive">
        <table class="table table-hover mb-0">
          <thead>
            <tr>
              <th>기기 이름</th>
              <th>상태</th>
              <th>최근 사용</th>
              <th class="text-end">작업</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in devices" :key="d.id">
              <td>{{ d.device_name || '이름 없는 기기' }}</td>
              <td><span class="badge" :class="deviceStatusMeta(d.status).cls">{{ deviceStatusMeta(d.status).label }}</span></td>
              <td>{{ formatRelative(d.last_used_at) }}</td>
              <td class="text-end">
                <button
                  class="btn btn-sm btn-outline-danger"
                  :disabled="d.status === 'revoked' || revokingIds.has(d.id)"
                  @click="revoke(d)"
                >
                  폐기
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="rowError" class="alert alert-danger py-2 small mt-3">{{ rowError }}</div>

    <!-- 발급 모달 -->
    <div v-if="showIssueModal" class="modal-backdrop-custom" @click.self="closeIssueModal">
      <div class="modal-dialog-custom" style="width:560px;max-width:94vw;">
        <div class="modal-content">
          <div class="modal-header d-flex justify-content-between align-items-center">
            <h5 class="mb-0">새 인증키 발급</h5>
            <button type="button" class="btn-close" aria-label="닫기" @click="closeIssueModal"></button>
          </div>

          <!-- 1) 입력 폼 -->
          <template v-if="step === 'form'">
            <form @submit.prevent="issue">
              <div class="modal-body">
                <label class="form-label small fw-semibold" for="deviceName">기기 이름</label>
                <input id="deviceName" v-model="deviceName" type="text" class="form-control" placeholder="예: 내 노트북" />
                <p class="text-faint small mt-2 mb-0">이 이름은 목록에서 어떤 기기가 발급받았는지 구분하는 용도로만 쓰입니다.</p>
              </div>
              <div class="modal-footer d-flex justify-content-end gap-2">
                <button type="button" class="btn btn-outline-secondary" @click="closeIssueModal">취소</button>
                <button type="submit" class="btn btn-primary" :disabled="!deviceName.trim()">발급</button>
              </div>
            </form>
          </template>

          <!-- 2) 발급 진행 중 -->
          <template v-else-if="step === 'issuing'">
            <div class="modal-body text-center py-5">
              <span class="spinner-border spinner-border-sm me-2"></span>인증키를 발급하는 중...
            </div>
          </template>

          <!-- 3) 실패 -->
          <template v-else-if="step === 'error'">
            <div class="modal-body">
              <div class="alert alert-danger py-2 small mb-0">{{ issueError }}</div>
            </div>
            <div class="modal-footer d-flex justify-content-end gap-2">
              <button type="button" class="btn btn-outline-secondary" @click="closeIssueModal">닫기</button>
              <button type="button" class="btn btn-primary" @click="step = 'form'">다시 시도</button>
            </div>
          </template>

          <!-- 4) 결과: .mcp.json 1회 노출 -->
          <template v-else-if="step === 'result'">
            <div class="modal-body">
              <div class="alert alert-warning py-2 small mb-3">
                <i class="bi bi-exclamation-triangle me-1"></i>
                이 설정은 지금만 표시됩니다. 창을 닫으면 다시 조회할 수 없으니(재발급 필요) 지금 복사하거나 다운로드하세요.
              </div>
              <label class="form-label small fw-semibold">.mcp.json</label>
              <pre class="p-3 bg-canvas border border-hairline rounded text-mono mb-0" style="font-size:0.8125rem; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-all;">{{ mcpJsonText }}</pre>
            </div>
            <div class="modal-footer d-flex justify-content-end gap-2">
              <button type="button" class="btn btn-outline-secondary d-flex align-items-center gap-1" @click="copyConfig">
                <i class="bi" :class="configCopied ? 'bi-check-lg' : 'bi-clipboard'"></i>
                {{ configCopied ? '복사됨' : '복사' }}
              </button>
              <button type="button" class="btn btn-outline-secondary d-flex align-items-center gap-1" @click="downloadConfig">
                <i class="bi bi-download"></i>
                다운로드
              </button>
              <button type="button" class="btn btn-primary" @click="closeIssueModal">완료</button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: '인증키 관리 · malgnai-hub',
  data() {
    return {
      devices: [],
      loading: true,
      error: false,
      errorMessage: '',
      revokingIds: new Set(),
      rowError: '',

      showIssueModal: false,
      step: 'form', // form | issuing | error | result
      deviceName: '',
      issueError: '',
      deviceToken: '',
      configCopied: false,
    }
  },
  computed: {
    mcpJsonText() {
      const config = {
        mcpServers: {
          'malgnai-hub': {
            url: `${window.location.origin}/mcp`,
            headers: { Authorization: `Bearer ${this.deviceToken}` },
          },
        },
      }
      return JSON.stringify(config, null, 2)
    },
  },
  async mounted() {
    await this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.error = false
      this.rowError = ''
      const { data, error } = await useApi('/api/devices')
      this.loading = false
      if (error) {
        this.error = true
        this.errorMessage = error?.message || '디바이스 목록을 불러오지 못했습니다.'
        return
      }
      this.devices = data?.data || []
    },
    async revoke(d) {
      if (!window.confirm(`"${d.device_name || '이름 없는 기기'}" 인증키를 폐기할까요? 이 기기는 즉시 접근이 차단됩니다.`)) return
      this.rowError = ''
      this.revokingIds.add(d.id)
      const { error } = await useApi(`/api/devices/${d.id}`, { method: 'DELETE' })
      this.revokingIds.delete(d.id)
      if (error) {
        this.rowError = error?.message || '인증키 폐기에 실패했습니다.'
        return
      }
      d.status = 'revoked'
    },
    openIssueModal() {
      this.step = 'form'
      this.deviceName = ''
      this.issueError = ''
      this.deviceToken = ''
      this.configCopied = false
      this.showIssueModal = true
    },
    closeIssueModal() {
      const hadResult = this.step === 'result'
      this.showIssueModal = false
      this.deviceToken = ''
      if (hadResult) this.load()
    },
    async issue() {
      this.step = 'issuing'
      this.issueError = ''
      try {
        const deviceId = crypto.randomUUID()
        const deviceName = this.deviceName.trim()

        const initRes = await useApi('/api/devices/pair-init', {
          method: 'POST',
          body: { device_id: deviceId, device_name: deviceName },
        })
        if (initRes.error) throw new Error(initRes.error?.message || '인증키 발급 요청에 실패했습니다.')
        const pairingCode = initRes.data?.data?.pairing_code ?? initRes.data?.pairing_code
        if (!pairingCode) throw new Error('페어링 코드를 받지 못했습니다.')

        const approveRes = await useApi('/api/devices/pair-approve', {
          method: 'POST',
          body: { pairing_code: pairingCode },
        })
        if (approveRes.error) throw new Error(approveRes.error?.message || '인증키 승인에 실패했습니다.')

        // pair-approve 직후 device_token이 바로 준비되지 않을 수 있어 pair-status를 짧게 재시도 폴링한다.
        let token = null
        for (let attempt = 0; attempt < 6 && !token; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 400))
          const statusRes = await useApi(`/api/devices/pair-status?code=${encodeURIComponent(pairingCode)}`)
          if (statusRes.error) continue
          const payload = statusRes.data?.data ?? statusRes.data
          token = payload?.device_token || null
        }
        if (!token) throw new Error('인증키를 발급받지 못했습니다. 다시 시도해주세요.')

        this.deviceToken = token
        this.step = 'result'
      } catch (e) {
        this.issueError = e?.message || '인증키 발급 중 오류가 발생했습니다.'
        this.step = 'error'
      }
    },
    async copyConfig() {
      const ok = await copyToClipboard(this.mcpJsonText)
      this.configCopied = ok
      if (ok) setTimeout(() => { this.configCopied = false }, 2000)
    },
    downloadConfig() {
      downloadTextFile('.mcp.json', this.mcpJsonText, 'application/json')
    },
    deviceStatusMeta,
    formatRelative,
  },
}
</script>
