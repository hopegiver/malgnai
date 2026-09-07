<template>
  <div>
    <div v-if="!guardReady"></div>

    <template v-else-if="!allowed">
      <div class="alert alert-warning"><i class="bi bi-shield-lock me-1"></i>관리자만 접근할 수 있는 화면입니다.</div>
    </template>

    <template v-else>
      <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
        <div>
          <h1 class="mb-0">사용자 관리</h1>
          <small class="text-muted" v-if="!loading && !error">전체 {{ users.length }}명</small>
        </div>
        <div class="d-flex align-items-center gap-2">
          <button class="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1" @click="load" :disabled="loading">
            <i class="bi" :class="loading ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'"></i>
            새로고침
          </button>
          <button class="btn btn-primary btn-sm d-flex align-items-center gap-1" @click="openCreateModal">
            <i class="bi bi-person-plus"></i>
            신규 사용자
          </button>
        </div>
      </div>

      <!-- 로딩 -->
      <div v-if="loading" class="card p-4 placeholder-glow">
        <span class="placeholder col-12 mb-2" style="height:2rem"></span>
        <span class="placeholder col-12 mb-2" style="height:2rem"></span>
        <span class="placeholder col-12" style="height:2rem"></span>
      </div>

      <!-- 에러 -->
      <div v-else-if="error" class="alert alert-warning d-flex justify-content-between align-items-center">
        <span><i class="bi bi-exclamation-triangle me-1"></i>{{ errorMessage }}</span>
        <button class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
      </div>

      <!-- 빈 상태 -->
      <div v-else-if="!users.length" class="text-center py-5">
        <i class="bi bi-people d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
        <div class="fw-medium mb-1 text-muted">등록된 사용자가 없습니다</div>
      </div>

      <!-- 목록 -->
      <div v-else class="card p-0">
        <div class="table-responsive">
          <table class="table table-hover mb-0">
            <thead>
              <tr>
                <th>이메일</th>
                <th>이름</th>
                <th>역할</th>
                <th>상태</th>
                <th>연동 아이디</th>
                <th class="text-end">작업</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td>{{ u.email }}</td>
                <td>{{ u.name || '-' }}</td>
                <td><span class="badge" :class="userRoleMeta(u.role).cls">{{ userRoleMeta(u.role).label }}</span></td>
                <td><span class="badge" :class="userStatusMeta(u.status).cls">{{ userStatusMeta(u.status).label }}</span></td>
                <td>
                  <code v-if="u.employee_id">{{ u.employee_id }}</code>
                  <span v-else class="badge bg-light text-dark">미연동</span>
                </td>
                <td class="text-end">
                  <div class="d-flex justify-content-end gap-2">
                    <button
                      class="btn btn-sm btn-outline-secondary"
                      :disabled="busyIds.has(u.id) || u.id === myUserId"
                      :title="u.id === myUserId ? '본인 역할은 변경할 수 없습니다' : ''"
                      @click="toggleRole(u)"
                    >
                      {{ u.role === 'administrator' ? '직원으로 변경' : '관리자로 변경' }}
                    </button>
                    <button
                      class="btn btn-sm"
                      :class="u.status === 'disabled' ? 'btn-outline-success' : 'btn-outline-danger'"
                      :disabled="busyIds.has(u.id) || u.id === myUserId"
                      :title="u.id === myUserId ? '본인 상태는 변경할 수 없습니다' : ''"
                      @click="toggleStatus(u)"
                    >
                      {{ u.status === 'disabled' ? '활성화' : '비활성화' }}
                    </button>
                    <button class="btn btn-sm btn-outline-primary" @click="openEditModal(u)">연동 아이디 편집</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="rowError" class="alert alert-danger py-2 small mt-3">{{ rowError }}</div>
    </template>

    <!-- 신규 사용자 모달 -->
    <div v-if="showCreateModal" class="modal-backdrop-custom" @click.self="closeCreateModal">
      <div class="modal-dialog-custom" style="width:440px;max-width:92vw;">
        <div class="modal-content">
          <div class="modal-header d-flex justify-content-between align-items-center">
            <h5 class="mb-0">{{ createdUser ? '계정이 생성되었습니다' : '신규 사용자' }}</h5>
            <button type="button" class="btn-close" aria-label="닫기" @click="closeCreateModal"></button>
          </div>

          <!-- 생성 폼 -->
          <template v-if="!createdUser">
            <form @submit.prevent="submitCreate">
              <div class="modal-body">
                <div class="mb-3">
                  <label class="form-label small fw-semibold" for="newEmail">이메일</label>
                  <input id="newEmail" v-model="createForm.email" type="email" class="form-control" placeholder="name@malgnsoft.com" :disabled="creating" />
                </div>
                <div class="mb-3">
                  <label class="form-label small fw-semibold" for="newName">이름</label>
                  <input id="newName" v-model="createForm.name" type="text" class="form-control" :disabled="creating" />
                </div>
                <div class="mb-1">
                  <label class="form-label small fw-semibold" for="newRole">역할</label>
                  <select id="newRole" v-model="createForm.role" class="form-select" :disabled="creating">
                    <option value="employee">직원</option>
                    <option value="administrator">관리자</option>
                  </select>
                </div>
                <div v-if="createError" class="alert alert-danger py-2 small mt-3 mb-0">{{ createError }}</div>
              </div>
              <div class="modal-footer d-flex justify-content-end gap-2">
                <button type="button" class="btn btn-outline-secondary" :disabled="creating" @click="closeCreateModal">취소</button>
                <button type="submit" class="btn btn-primary" :disabled="createDisabled">
                  <span v-if="creating" class="spinner-border spinner-border-sm me-2"></span>
                  생성
                </button>
              </div>
            </form>
          </template>

          <!-- 생성 결과: 임시 비밀번호 1회 노출 -->
          <template v-else>
            <div class="modal-body">
              <div class="alert alert-warning py-2 small mb-3">
                <i class="bi bi-exclamation-triangle me-1"></i>
                이 임시 비밀번호는 지금만 표시됩니다. 창을 닫으면 다시 확인할 수 없으니 지금 복사해 전달하세요.
              </div>
              <div class="mb-2 small text-muted">{{ createdUser.email }}</div>
              <div class="d-flex align-items-center gap-2">
                <code class="flex-grow-1 p-2 bg-canvas border border-hairline rounded text-mono" style="font-size:0.9rem; word-break:break-all;">{{ createdUser.temp_password }}</code>
                <button type="button" class="btn btn-sm btn-outline-secondary flex-shrink-0" @click="copyTempPassword">
                  <i class="bi" :class="tempPwCopied ? 'bi-check-lg' : 'bi-clipboard'"></i>
                </button>
              </div>
            </div>
            <div class="modal-footer d-flex justify-content-end">
              <button type="button" class="btn btn-primary" @click="closeCreateModal">완료</button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 연동 아이디 편집 모달(docs/design/usage-employee-identity-linking.md §5·§7.3-A) — 실제
         PUT /api/admin/users/:id/employee-id 왕복. 제안값은 자동 채움이 아니라 사용자가 누르는
         동작으로만 채워지고, 연결 해제는 저장과 분리된 별도 동작이다. -->
    <div v-if="editModal.open" class="modal-backdrop-custom" @click.self="closeEditModal">
      <div class="modal-dialog-custom" style="width:440px;max-width:92vw;">
        <div class="modal-content">
          <div class="modal-header d-flex justify-content-between align-items-center">
            <h5 class="mb-0">연동 아이디 편집</h5>
            <button type="button" class="btn-close" aria-label="닫기" @click="closeEditModal"></button>
          </div>
          <div class="modal-body">
            <div class="mb-3 small text-muted">{{ editModal.target.email }} · {{ editModal.target.name || '-' }}</div>

            <label class="form-label small fw-semibold" for="empIdInput">연동 아이디</label>
            <div class="d-flex gap-2 mb-1">
              <input id="empIdInput" v-model="editModal.value" type="text" class="form-control" placeholder="예: hopegiver" :disabled="editModal.saving" />
              <button type="button" class="btn btn-outline-secondary text-nowrap" :disabled="editModal.saving || !editModal.suggestion" @click="editModal.value = editModal.suggestion">
                제안값 채우기
              </button>
            </div>
            <div class="small text-faint mb-3">소문자·숫자·<code>._%+-</code>만 사용, 최대 64자. 제안값: {{ editModal.suggestion || '(이메일에서 도출 불가)' }}</div>

            <div v-if="editModal.error" class="alert alert-danger py-2 small mb-3">
              {{ editModal.error }}
              <div v-if="editModal.conflict" class="mt-1">
                이미 <strong>{{ editModal.conflict.conflict_email }}</strong> 사용자가 이 값을 쓰고 있습니다. 먼저 그 사용자의 연동을 해제해야 합니다(자동 이전은 지원하지 않습니다).
              </div>
            </div>

            <div v-if="editModal.warnings.length" class="alert alert-warning py-2 small mb-3">
              <div v-for="w in editModal.warnings" :key="w">{{ warningMessage(w) }}</div>
            </div>

            <div v-if="editModal.canUndo" class="alert alert-success py-2 small mb-0 d-flex justify-content-between align-items-center">
              <span>변경되었습니다.</span>
              <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="editModal.saving" @click="undoEdit">되돌리기</button>
            </div>
          </div>
          <div class="modal-footer d-flex justify-content-between">
            <button type="button" class="btn btn-outline-danger btn-sm" :disabled="editModal.saving || !editModal.target.employee_id" @click="unlinkEdit">연동 해제</button>
            <div class="d-flex gap-2">
              <button type="button" class="btn btn-outline-secondary" :disabled="editModal.saving" @click="closeEditModal">닫기</button>
              <button type="button" class="btn btn-primary" :disabled="editModal.saving || !editModal.value.trim()" @click="saveEdit">
                <span v-if="editModal.saving" class="spinner-border spinner-border-sm me-2"></span>저장
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  title: '사용자 관리 · malgnai-hub',
  data() {
    return {
      guardReady: false,
      allowed: false,
      myUserId: null,

      users: [],
      loading: true,
      error: false,
      errorMessage: '',
      busyIds: new Set(),
      rowError: '',

      showCreateModal: false,
      createForm: { email: '', name: '', role: 'employee' },
      creating: false,
      createError: '',
      createdUser: null,
      tempPwCopied: false,

      // 연동 아이디 편집 모달 상태(§5·§7.3-A). canUndo는 직전 성공 응답의 previous_employee_id로
      // 되돌리기 1회를 제공하기 위한 플래그 — 값 자체는 lastPrevious에 보관한다.
      editModal: { open: false, target: null, value: '', suggestion: '', saving: false, error: '', conflict: null, warnings: [], lastPrevious: undefined, canUndo: false },
    }
  },
  computed: {
    createDisabled() {
      return this.creating || !this.createForm.email.trim() || !this.createForm.name.trim()
    },
  },
  async mounted() {
    const me = await getCurrentUser()
    this.myUserId = me?.id ?? null
    this.allowed = me?.role === 'administrator'
    this.guardReady = true
    if (!this.allowed) {
      this.$router.replace('/')
      return
    }
    await this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.error = false
      this.rowError = ''
      const { data, error } = await useApi('/api/admin/users')
      this.loading = false
      if (error) {
        this.error = true
        this.errorMessage = error?.message || '사용자 목록을 불러오지 못했습니다.'
        return
      }
      this.users = data?.data || []
    },
    async toggleRole(u) {
      const nextRole = u.role === 'administrator' ? 'employee' : 'administrator'
      await this.patchUser(u, { role: nextRole })
    },
    async toggleStatus(u) {
      const nextStatus = u.status === 'disabled' ? 'active' : 'disabled'
      await this.patchUser(u, { status: nextStatus })
    },
    async patchUser(u, body) {
      this.rowError = ''
      this.busyIds.add(u.id)
      const { data, error } = await useApi(`/api/admin/users/${u.id}`, { method: 'PATCH', body })
      this.busyIds.delete(u.id)
      if (error) {
        this.rowError = error?.message || '사용자 정보 변경에 실패했습니다.'
        return
      }
      Object.assign(u, body)
    },
    openCreateModal() {
      this.createForm = { email: '', name: '', role: 'employee' }
      this.createError = ''
      this.createdUser = null
      this.tempPwCopied = false
      this.showCreateModal = true
    },
    closeCreateModal() {
      const hadCreated = !!this.createdUser
      this.showCreateModal = false
      this.createdUser = null
      if (hadCreated) this.load()
    },
    async submitCreate() {
      this.creating = true
      this.createError = ''
      const { data, error } = await useApi('/api/admin/users', {
        method: 'POST',
        body: {
          email: this.createForm.email.trim(),
          name: this.createForm.name.trim(),
          role: this.createForm.role,
        },
      })
      this.creating = false
      if (error) {
        this.createError = error?.message || '사용자 생성에 실패했습니다.'
        return
      }
      this.createdUser = data?.data ?? data
    },
    async copyTempPassword() {
      if (!this.createdUser?.temp_password) return
      const ok = await copyToClipboard(this.createdUser.temp_password)
      this.tempPwCopied = ok
      if (ok) setTimeout(() => { this.tempPwCopied = false }, 2000)
    },
    // 연동 아이디 편집(§5·§7.3-A). 제안값은 EMPLOYEE_ID_RE(서버와 동일 패턴)를 통과하는 이메일
    // 로컬파트일 때만 채운다 — 서버 검증 규칙(§5.3)을 프런트에서 그대로 복제하지 않고 후보만
    // 계산한다(최종 검증은 항상 서버가 한다).
    deriveEmployeeIdSuggestion(email) {
      if (!email || !email.includes('@')) return ''
      const local = email.split('@')[0].trim().toLowerCase()
      return /^[a-z0-9._%+-]+$/.test(local) ? local : ''
    },
    openEditModal(u) {
      this.editModal = {
        open: true,
        target: u,
        value: u.employee_id || '',
        suggestion: this.deriveEmployeeIdSuggestion(u.email),
        saving: false,
        error: '',
        conflict: null,
        warnings: [],
        lastPrevious: undefined,
        canUndo: false,
      }
    },
    closeEditModal() {
      this.editModal.open = false
    },
    async saveEdit() {
      const value = this.editModal.value.trim().toLowerCase()
      if (!value) return
      await this.submitEmployeeId(value)
    },
    async unlinkEdit() {
      if (!window.confirm('이 사용자의 연동 아이디를 해제할까요? 해제하면 이후 사용량이 미연동으로 표시됩니다.')) return
      await this.submitEmployeeId(null)
    },
    async undoEdit() {
      if (this.editModal.lastPrevious === undefined) return
      await this.submitEmployeeId(this.editModal.lastPrevious, { isUndo: true })
    },
    async submitEmployeeId(employeeId, opts = {}) {
      const target = this.editModal.target
      this.editModal.saving = true
      this.editModal.error = ''
      this.editModal.conflict = null
      const { data, error } = await useApi(`/api/admin/users/${target.id}/employee-id`, {
        method: 'PUT',
        body: { employee_id: employeeId },
      })
      this.editModal.saving = false
      if (error) {
        this.editModal.error = (error && error.message) || '연동 아이디 변경에 실패했습니다.'
        if (error && error.details && error.details.conflict_email) this.editModal.conflict = error.details
        return
      }
      const updatedUser = data && data.user
      if (updatedUser) {
        // 모달 대상과 목록의 해당 행을 함께 갱신 — 목록 재조회 없이도 화면이 즉시 반영된다.
        Object.assign(target, { employee_id: updatedUser.employee_id })
        const row = this.users.find((x) => x.id === target.id)
        if (row) row.employee_id = updatedUser.employee_id
      }
      this.editModal.value = (updatedUser && updatedUser.employee_id) || ''
      this.editModal.warnings = (data && data.warnings) || []
      if (opts.isUndo) {
        this.editModal.canUndo = false
        this.editModal.lastPrevious = undefined
      } else if (data && data.changed && data.previous_employee_id !== undefined) {
        this.editModal.lastPrevious = data.previous_employee_id
        this.editModal.canUndo = true
      } else {
        this.editModal.canUndo = false
      }
    },
    warningMessage(w) {
      const M = {
        local_part_mismatch: '이메일 로컬파트와 다른 값입니다. 실제 관측 값과 대조했는지 확인하세요.',
        overwrote_existing_link: '이 사용자에게 이미 연결돼 있던 다른 값을 덮어썼습니다.',
      }
      return M[w] || w
    },
    userRoleMeta,
    userStatusMeta,
  },
}
</script>
