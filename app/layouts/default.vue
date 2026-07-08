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
        <span class="brand-name">맑은AI</span>
        <button class="admin-sidebar-close ms-auto admin-icon-btn d-lg-none" @click="isSidebarOpen = false">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <nav class="admin-nav flex-grow-1 px-2 py-2" style="overflow-y: auto;" role="navigation" aria-label="주 네비게이션">
        <!-- 홈 (단독) -->
        <router-link to="/" class="admin-nav-item" :class="{ 'is-active': $route.path === '/' }" @click="closeSidebarOnMobile">
          <i class="bi bi-house"></i>
          홈
          <span v-if="pendingCount > 0 && admin" class="nav-badge ms-auto">{{ pendingCount }}</span>
        </router-link>

        <!-- 내 업무 -->
        <div class="nav-grp-label">내 업무</div>
        <router-link to="/projects" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/projects') }" @click="closeSidebarOnMobile">
          <i class="bi bi-folder2"></i>
          프로젝트
        </router-link>
        <router-link to="/approvals" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/approvals') }" @click="closeSidebarOnMobile" aria-label="승인함">
          <i class="bi bi-inbox-fill"></i>
          승인함
          <span v-if="pendingCount > 0" class="nav-badge ms-auto" :aria-label="'승인 대기 ' + pendingCount + '건'">{{ pendingCount }}</span>
        </router-link>

        <!-- AI 운영 -->
        <div class="nav-grp-label">AI 운영</div>
        <router-link to="/agents" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/agents') }" @click="closeSidebarOnMobile">
          <i class="bi bi-robot"></i>
          에이전트
        </router-link>
        <router-link v-if="admin" to="/autonomy" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/autonomy') }" @click="closeSidebarOnMobile">
          <i class="bi bi-broadcast"></i>
          자율 제어판
          <span class="ms-auto nav-status-dot" :class="autonomyEnabled ? 'nav-status-dot--on' : 'nav-status-dot--off'" :title="autonomyEnabled ? '가동 중' : '정지'"></span>
        </router-link>

        <!-- 기록 -->
        <div class="nav-grp-label">기록</div>
        <router-link to="/activities" class="admin-nav-item" :class="{ 'is-active': $route.path === '/activities' }" @click="closeSidebarOnMobile">
          <i class="bi bi-clock-history"></i>
          활동 로그
        </router-link>
        <router-link v-if="admin" to="/claude" class="admin-nav-item" :class="{ 'is-active': $route.path === '/claude' }" @click="closeSidebarOnMobile">
          <i class="bi bi-bar-chart"></i>
          AI 비용
        </router-link>
        <router-link v-if="admin" to="/insights" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/insights') }" @click="closeSidebarOnMobile">
          <i class="bi bi-graph-up"></i>
          인사이트
        </router-link>

        <!-- 시스템 -->
        <div class="nav-grp-label">시스템</div>
        <router-link v-if="admin" to="/users" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/users') }" @click="closeSidebarOnMobile">
          <i class="bi bi-people"></i>
          사용자 관리
        </router-link>
        <router-link to="/settings" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/settings') }" @click="closeSidebarOnMobile">
          <i class="bi bi-gear"></i>
          설정
        </router-link>
      </nav>

      <div class="admin-sidebar-user" style="cursor:default">
        <div class="admin-avatar admin-avatar-initials" style="cursor:pointer" @click="$router.push('/settings')" title="설정">
          {{ userInitials }}
        </div>
        <div class="d-flex flex-column overflow-hidden">
          <span class="admin-user-name text-truncate">{{ userName }}</span>
          <span class="admin-user-email">{{ admin ? '관리자' : '멤버' }}</span>
        </div>
        <button class="admin-icon-btn ms-auto flex-shrink-0" title="로그아웃" @click="signOut">
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

        <!-- 브레드크럼 / 페이지 타이틀 -->
        <div class="d-flex align-items-center gap-1 text-truncate">
          <template v-for="(crumb, i) in breadcrumbs" :key="i">
            <router-link v-if="crumb.to" :to="crumb.to" class="text-decoration-none small text-muted fw-medium hdr-crumb-link">{{ crumb.label }}</router-link>
            <span v-else class="fw-semibold hdr-page-title">{{ crumb.label }}</span>
            <i v-if="i < breadcrumbs.length - 1" class="bi bi-chevron-right text-faint" style="font-size:11px"></i>
          </template>
        </div>

        <div class="flex-grow-1"></div>
      </header>

      <main class="flex-grow-1 p-3 p-lg-4 bg-canvas">
        <slot />
      </main>
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      isSidebarOpen: false,
      admin: isAdmin(),
      pendingCount: 0,
      autonomyEnabled: false,
    }
  },
  computed: {
    userInitials() {
      const p = tokenPayload()
      if (!p?.sub) return '?'
      return p.sub.slice(0, 2).toUpperCase()
    },
    userName() {
      return tokenPayload()?.sub || '사용자'
    },
    breadcrumbs() {
      const p = this.$route.path
      if (p === '/') return [{ label: '홈' }]
      if (p.match(/^\/projects\/[^/]+/)) return [{ label: '프로젝트', to: '/projects' }, { label: this.$route.params?.id || '상세' }]
      if (p.match(/^\/agents\/.+/)) return [{ label: '에이전트', to: '/agents' }, { label: this.$route.params?.name || '상세' }]
      if (p.startsWith('/projects')) return [{ label: '프로젝트' }]
      if (p.startsWith('/approvals')) return [{ label: '승인함' }]
      if (p.startsWith('/autonomy')) return [{ label: '자율 제어판' }]
      if (p.startsWith('/agents')) return [{ label: '에이전트' }]
      if (p.startsWith('/activities')) return [{ label: '활동 로그' }]
      if (p.startsWith('/claude')) return [{ label: 'AI 비용' }]
      if (p.startsWith('/insights')) return [{ label: '인사이트' }]
      if (p.startsWith('/users')) return [{ label: '사용자 관리' }]
      if (p.startsWith('/settings')) return [{ label: '설정' }]
      return [{ label: '' }]
    }
  },
  async mounted() {
    this.loadSidebarData()
  },
  methods: {
    async loadSidebarData() {
      const [pendingRes, autoRes] = await Promise.allSettled([
        useApi('/api/commands?inbox=pending&limit=100'),
        useApi('/api/lead/autonomy'),
      ])
      if (pendingRes.status === 'fulfilled' && !pendingRes.value.error) {
        this.pendingCount = (pendingRes.value.data?.commands || []).length
      }
      if (autoRes.status === 'fulfilled' && !autoRes.value.error) {
        this.autonomyEnabled = autoRes.value.data?.enabled ?? false
      }
    },
    closeSidebarOnMobile() {
      if (window.innerWidth < 992) {
        this.isSidebarOpen = false
      }
    },
    signOut() {
      localStorage.removeItem('token')
      this.$router.replace('/login')
    }
  }
}
</script>

<style>
/* 레이아웃 치수 — base.css 토큰과 연동 */
</style>
