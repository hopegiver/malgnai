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
        <router-link to="/console" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/console') }" @click="closeSidebarOnMobile">
          <i class="bi bi-chat-square-text"></i>
          AI 콘솔
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
        <router-link v-if="staff" to="/claude" class="admin-nav-item" :class="{ 'is-active': $route.path === '/claude' }" @click="closeSidebarOnMobile">
          <i class="bi bi-bar-chart"></i>
          AI 비용
        </router-link>
        <router-link v-if="staff" to="/insights" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/insights') }" @click="closeSidebarOnMobile">
          <i class="bi bi-graph-up"></i>
          인사이트
        </router-link>

        <!-- 시스템 -->
        <div class="nav-grp-label">시스템</div>
        <router-link v-if="admin" to="/users" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/users') }" @click="closeSidebarOnMobile">
          <i class="bi bi-people"></i>
          사용자 관리
        </router-link>
        <router-link to="/feature-requests" class="admin-nav-item" :class="{ 'is-active': $route.path.startsWith('/feature-requests') }" @click="closeSidebarOnMobile">
          <i class="bi bi-lightbulb"></i>
          기능 요청
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
          <span class="admin-user-email">{{ admin ? '최고관리자' : '멤버' }}</span>
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

      <main class="flex-grow-1 p-3 p-lg-4 bg-canvas admin-main">
        <slot />
      </main>
    </div>

    <!-- 모바일 전용 하단 탭바 (lg=992px 미만, 사이드바와 동일 breakpoint에서만 표시) -->
    <nav class="admin-tabbar d-lg-none" role="navigation" aria-label="하단 탭 내비게이션">
      <router-link v-if="!admin" to="/" class="admin-tab-item" :class="{ 'is-active': $route.path === '/' }">
        <i class="bi bi-house"></i>
        <span>홈</span>
      </router-link>
      <router-link to="/projects" class="admin-tab-item" :class="{ 'is-active': $route.path.startsWith('/projects') }">
        <i class="bi bi-folder2"></i>
        <span>프로젝트</span>
      </router-link>
      <router-link to="/approvals" class="admin-tab-item" :class="{ 'is-active': $route.path.startsWith('/approvals') }" aria-label="승인함">
        <span class="position-relative">
          <i class="bi bi-inbox-fill"></i>
          <span v-if="pendingCount > 0" class="nav-badge nav-badge--tab" :aria-label="'승인 대기 ' + pendingCount + '건'">{{ pendingCount }}</span>
        </span>
        <span>승인함</span>
      </router-link>
      <router-link to="/console" class="admin-tab-item" :class="{ 'is-active': $route.path.startsWith('/console') }">
        <i class="bi bi-chat-square-text"></i>
        <span>AI 콘솔</span>
      </router-link>
      <router-link to="/activities" class="admin-tab-item" :class="{ 'is-active': $route.path === '/activities' }">
        <i class="bi bi-clock-history"></i>
        <span>활동 로그</span>
      </router-link>
      <router-link v-if="staff" to="/claude" class="admin-tab-item" :class="{ 'is-active': $route.path === '/claude' }">
        <i class="bi bi-bar-chart"></i>
        <span>AI 비용</span>
      </router-link>
      <router-link v-if="!admin" to="/settings" class="admin-tab-item" :class="{ 'is-active': $route.path.startsWith('/settings') }">
        <i class="bi bi-gear"></i>
        <span>설정</span>
      </router-link>
    </nav>

    <!-- PWA 설치 유도 배너 -->
    <div v-if="showInstallBanner" class="pwa-install-banner d-flex align-items-center gap-2 gap-sm-3 position-fixed start-50 translate-middle-x px-3 py-2 shadow-sm" role="dialog" aria-label="앱 설치 안내">
      <i class="bi bi-download fs-5 flex-shrink-0" style="color:#5B6AF5"></i>
      <div class="flex-grow-1 small fw-medium text-truncate">앱으로 설치할까요?</div>
      <button type="button" class="btn btn-sm text-white flex-shrink-0" style="background-color:#5B6AF5" @click="installPwa">설치</button>
      <button type="button" class="admin-icon-btn mk-icon-btn flex-shrink-0" aria-label="닫기" @click="dismissInstallBanner">
        <i class="bi bi-x-lg"></i>
      </button>
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      isSidebarOpen: false,
      admin: isSuperAdmin(),
      staff: isStaff(),
      pendingCount: 0,
      autonomyEnabled: false,
      _approvalsUpdatedHandler: null,
      _tokenRefreshTimer: null,
      showInstallBanner: false,
      _deferredInstallPrompt: null,
      _beforeInstallPromptHandler: null,
      _appInstalledHandler: null,
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
      if (p.startsWith('/console')) return [{ label: 'AI 콘솔' }]
      if (p.startsWith('/feature-requests')) return [{ label: '기능 요청' }]
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
    this._approvalsUpdatedHandler = () => this.loadSidebarData()
    window.addEventListener('approvals-updated', this._approvalsUpdatedHandler)
    // PWA: Service Worker 등록 (설치 가능성 필수)
    this.registerServiceWorker()
    // Push: 알림 구독 (선택사항)
    this.initializePushNotifications()
    // PWA: 설치 유도 배너 (beforeinstallprompt 캐치)
    this.setupInstallPrompt()
    // 탭을 오래 열어두는 경우 대비: access token 만료가 임박하면 5분마다 미리 갱신
    // (로그인 페이지엔 이 레이아웃이 적용되지 않으므로 별도 분기 불필요)
    this._tokenRefreshTimer = setInterval(() => this.maybeRefreshToken(), 5 * 60 * 1000)
  },
  beforeUnmount() {
    if (this._approvalsUpdatedHandler) {
      window.removeEventListener('approvals-updated', this._approvalsUpdatedHandler)
    }
    if (this._tokenRefreshTimer) {
      clearInterval(this._tokenRefreshTimer)
      this._tokenRefreshTimer = null
    }
    if (this._beforeInstallPromptHandler) {
      window.removeEventListener('beforeinstallprompt', this._beforeInstallPromptHandler)
    }
    if (this._appInstalledHandler) {
      window.removeEventListener('appinstalled', this._appInstalledHandler)
    }
  },
  methods: {
    async maybeRefreshToken() {
      // 남은 유효시간이 10분 미만이면 미리 갱신(만료 후 요청이 튕기는 것 방지).
      const token = localStorage.getItem('token')
      if (!token) return
      try {
        const payload = JSON.parse(atob(token.split('.')[1]))
        const remainingMs = payload.exp ? payload.exp * 1000 - Date.now() : 0
        if (remainingMs < 10 * 60 * 1000) {
          await refreshAccessToken()
        }
      } catch {
        // 디코드 실패 시 다음 API 호출의 401 처리(useApi)에 맡긴다.
      }
    },
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
    async registerServiceWorker() {
      // PWA: Service Worker 등록 (설치 가능성을 위해 mount 시점에 필수)
      try {
        if ('serviceWorker' in navigator) {
          await navigator.serviceWorker.register('/sw.js', { scope: '/' })
          console.log('[PWA] Service Worker registered')
        }
      } catch (err) {
        console.error('[PWA] Service Worker registration failed:', err)
      }
    },
    async initializePushNotifications() {
      // Push notification initialization (non-blocking)
      try {
        // Check browser support
        if (!('PushManager' in window) || !('Notification' in window)) {
          console.log('[Push] Browser does not support web push notifications')
          return
        }

        // Auto-subscribe to push if already had permission
        if (Notification.permission === 'granted') {
          this.subscribeToPush()
        }
      } catch (err) {
        console.error('[Push] Initialization error:', err)
      }
    },
    async subscribeToPush() {
      try {
        // Get VAPID key and subscribe
        const vapidRes = await useApi('/api/system/vapid-public-key')
        if (vapidRes.error || !vapidRes.data?.publicKey) {
          console.warn('[Push] VAPID key not available')
          return
        }

        const vapidKey = vapidRes.data.publicKey
        const vapidKeyUint8 = this.urlBase64ToUint8Array(vapidKey)

        const registration = await navigator.serviceWorker.ready
        const existing = await registration.pushManager.getSubscription()

        if (existing) {
          // Already subscribed
          return
        }

        // Subscribe to push
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyUint8
        })

        // Send subscription to server
        const result = await useApi('/api/push/subscribe', {
          method: 'POST',
          body: { subscription }
        })

        if (!result.error) {
          console.log('[Push] Successfully subscribed to push notifications')
        }
      } catch (err) {
        console.warn('[Push] Subscribe failed:', err)
      }
    },
    urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
      const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/')
      const rawData = window.atob(base64)
      const outputArray = new Uint8Array(rawData.length)
      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i)
      }
      return outputArray
    },
    setupInstallPrompt() {
      // 이미 standalone(설치된 앱)으로 실행 중이면 배너를 아예 띄우지 않는다.
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
        return
      }
      this._beforeInstallPromptHandler = (e) => {
        // 브라우저 기본 미니 인포바를 막고, 이벤트를 저장해뒀다가 커스텀 배너에서 사용한다.
        e.preventDefault()
        this._deferredInstallPrompt = e
        if (this.isInstallBannerRecentlyDismissed()) return
        this.showInstallBanner = true
      }
      this._appInstalledHandler = () => {
        // 설치 완료: 배너 숨김 + 재노출 방지용 상태 정리
        this.showInstallBanner = false
        this._deferredInstallPrompt = null
        localStorage.removeItem('pwa_install_dismissed_at')
      }
      window.addEventListener('beforeinstallprompt', this._beforeInstallPromptHandler)
      window.addEventListener('appinstalled', this._appInstalledHandler)
    },
    isInstallBannerRecentlyDismissed() {
      const dismissedAt = parseInt(localStorage.getItem('pwa_install_dismissed_at') || '', 10)
      if (!dismissedAt) return false
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
      return (Date.now() - dismissedAt) < sevenDaysMs
    },
    async installPwa() {
      const promptEvent = this._deferredInstallPrompt
      if (!promptEvent) {
        this.showInstallBanner = false
        return
      }
      promptEvent.prompt()
      try {
        await promptEvent.userChoice
      } catch (err) {
        console.warn('[PWA] install prompt failed:', err)
      }
      // beforeinstallprompt 이벤트는 1회용이라 결과와 무관하게 재사용 불가 — 정리
      this._deferredInstallPrompt = null
      this.showInstallBanner = false
    },
    dismissInstallBanner() {
      this.showInstallBanner = false
      localStorage.setItem('pwa_install_dismissed_at', String(Date.now()))
    },
    closeSidebarOnMobile() {
      if (window.innerWidth < 992) {
        this.isSidebarOpen = false
      }
    },
    signOut() {
      logout()
    }
  }
}
</script>

<style>
/* 레이아웃 치수 — base.css 토큰과 연동 */

/* PWA 설치 유도 배너 */
.pwa-install-banner {
  bottom: 16px;
  z-index: 200;
  max-width: 480px;
  width: calc(100% - 32px);
  background-color: var(--color-canvas-warm, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 12px;
}

@media (max-width: 991.98px) {
  /* 모바일: 하단 탭바(admin-tabbar) 위에 오도록 오프셋 */
  .pwa-install-banner {
    bottom: calc(72px + env(safe-area-inset-bottom, 0px));
  }
}
</style>
