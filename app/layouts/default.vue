<template>
  <div class="admin-wrap d-flex min-vh-100">
    <div v-if="isSidebarOpen" class="admin-sidebar-overlay" @click="isSidebarOpen = false"></div>

    <!-- Sidebar -->
    <aside class="admin-sidebar d-flex flex-column flex-shrink-0" :class="{ open: isSidebarOpen }">
      <div class="admin-sidebar-logo d-flex align-items-center gap-2 px-3">
        <div class="admin-logo-icon d-flex align-items-center justify-content-center">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M7 8h10M7 12h10M7 16h6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
        <span class="brand-name">malgnai-hub</span>
        <button class="admin-sidebar-close ms-auto admin-icon-btn d-lg-none" @click="isSidebarOpen = false" aria-label="메뉴 닫기">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <nav class="admin-nav flex-grow-1 px-2 py-2" style="overflow-y: auto;" role="navigation" aria-label="주 네비게이션">
        <router-link to="/" class="admin-nav-item" :class="{ 'is-active': $route.path === '/' }" @click="closeSidebarOnMobile">
          <i class="bi bi-folder2"></i>
          프로젝트
        </router-link>
        <router-link to="/usage" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/usage') }" @click="closeSidebarOnMobile">
          <i class="bi bi-bar-chart"></i>
          사용량
        </router-link>
        <router-link to="/profile" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/profile') }" @click="closeSidebarOnMobile">
          <i class="bi bi-person"></i>
          프로필
        </router-link>
        <router-link to="/keys" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/keys') }" @click="closeSidebarOnMobile">
          <i class="bi bi-key"></i>
          인증키 관리
        </router-link>
        <router-link v-if="isAdmin" to="/admin/users" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/admin/users') }" @click="closeSidebarOnMobile">
          <i class="bi bi-people"></i>
          사용자 관리
        </router-link>
      </nav>

      <div class="admin-sidebar-user" style="cursor:default">
        <div class="admin-avatar admin-avatar-initials">
          {{ userInitials }}
        </div>
        <div class="d-flex flex-column overflow-hidden">
          <span class="admin-user-name text-truncate">{{ userName }}</span>
          <span class="admin-user-email text-truncate">{{ userEmail }}</span>
        </div>
        <button class="admin-icon-btn ms-auto flex-shrink-0" title="로그아웃" aria-label="로그아웃" @click="signOut">
          <i class="bi bi-box-arrow-right"></i>
        </button>
      </div>
    </aside>

    <div class="admin-sidebar-spacer flex-shrink-0 d-none d-lg-block"></div>

    <div class="d-flex flex-column flex-grow-1" style="min-height: 100vh; min-width: 0;">
      <header class="admin-header d-flex align-items-center px-3 px-lg-4 border-bottom border-hairline bg-canvas">
        <button class="admin-icon-btn d-lg-none me-2" @click="isSidebarOpen = true" aria-label="메뉴 열기">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>

        <div class="d-flex align-items-center gap-1 text-truncate">
          <template v-for="(crumb, i) in breadcrumbs" :key="i">
            <router-link v-if="crumb.to" :to="crumb.to" class="text-decoration-none small text-muted fw-medium hdr-crumb-link">{{ crumb.label }}</router-link>
            <span v-else class="fw-semibold hdr-page-title">{{ crumb.label }}</span>
            <i v-if="i < breadcrumbs.length - 1" class="bi bi-chevron-right text-faint" style="font-size:11px"></i>
          </template>
        </div>

        <div class="flex-grow-1"></div>
      </header>

      <main class="flex-grow-1 p-3 p-lg-4 bg-canvas admin-main">
        <slot />
      </main>
    </div>

    <!-- 모바일 전용 하단 탭바 -->
    <nav class="admin-tabbar d-lg-none" role="navigation" aria-label="하단 탭 내비게이션">
      <router-link to="/" class="admin-tab-item" :class="{ 'is-active': $route.path === '/' }">
        <i class="bi bi-folder2"></i>
        <span>프로젝트</span>
      </router-link>
      <router-link to="/usage" class="admin-tab-item" :class="{ 'is-active': $route.path.startsWith('/usage') }">
        <i class="bi bi-bar-chart"></i>
        <span>사용량</span>
      </router-link>
      <a href="#" class="admin-tab-item" @click.prevent="signOut">
        <i class="bi bi-box-arrow-right"></i>
        <span>로그아웃</span>
      </a>
    </nav>
  </div>
</template>

<script>
export default {
  data() {
    return {
      isSidebarOpen: false,
      user: null,
      _tokenRefreshTimer: null,
    }
  },
  computed: {
    userInitials() {
      const name = this.userName
      return name && name !== '사용자' ? name.slice(0, 2).toUpperCase() : '?'
    },
    userName() {
      return this.user?.name || this.user?.email || '사용자'
    },
    userEmail() {
      return this.user?.email || ''
    },
    breadcrumbs() {
      const p = this.$route.path
      if (p === '/') return [{ label: '프로젝트' }]
      if (p.match(/^\/projects\/[^/]+/)) return [{ label: '프로젝트', to: '/' }, { label: this.$route.params?.id || '프로젝트 상세' }]
      if (p.startsWith('/usage')) return [{ label: '사용량' }]
      if (p.startsWith('/pair')) return [{ label: '기기 연결' }]
      if (p.startsWith('/profile')) return [{ label: '프로필' }]
      if (p.startsWith('/keys')) return [{ label: '인증키 관리' }]
      if (p.startsWith('/admin/users')) return [{ label: '사용자 관리' }]
      return [{ label: '' }]
    },
    isAdmin() {
      return this.user?.role === 'administrator'
    },
  },
  async mounted() {
    this.user = await getCurrentUser()
    // 탭을 오래 열어두는 경우 대비: access token 만료가 임박하면 5분마다 미리 갱신
    // (로그인 페이지엔 이 레이아웃이 적용되지 않으므로 별도 분기 불필요)
    this._tokenRefreshTimer = setInterval(() => this.maybeRefreshToken(), 5 * 60 * 1000)
  },
  beforeUnmount() {
    if (this._tokenRefreshTimer) {
      clearInterval(this._tokenRefreshTimer)
      this._tokenRefreshTimer = null
    }
  },
  methods: {
    async maybeRefreshToken() {
      // 남은 유효시간이 10분 미만이면 미리 갱신(만료 후 요청이 튕기는 것 방지).
      const token = localStorage.getItem('token')
      if (!token) return
      try {
        const payload = decodeJwtPayload(token)
        const remainingMs = payload?.exp ? payload.exp * 1000 - Date.now() : 0
        if (remainingMs < 10 * 60 * 1000) {
          await refreshAccessToken()
        }
      } catch {
        // 디코드 실패 시 다음 API 호출의 401 처리(useApi)에 맡긴다.
      }
    },
    closeSidebarOnMobile() {
      if (window.innerWidth < 992) {
        this.isSidebarOpen = false
      }
    },
    signOut() {
      logout()
    },
  },
}
</script>
