/**
 * sw-registration.js — Service Worker 등록 및 업데이트 감시
 * - Service Worker 등록
 * - controllerchange 이벤트 감시 (새 버전 배포 감지)
 * - 세션 스토리지에 update 배너 상태 저장
 */

export const SwRegistration = {
  /**
   * Service Worker 등록 + controllerchange 이벤트 감시
   * @returns {Promise<ServiceWorkerRegistration|null>}
   */
  async register() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[SW] Service Worker not supported')
      return null
    }

    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/'
      })
      console.log('[SW] Service Worker registered:', registration)

      // 새로운 Service Worker가 활성화되면 업데이트 배너 표시
      this.watchForUpdates()

      return registration
    } catch (err) {
      console.error('[SW] Service Worker registration failed:', err)
      return null
    }
  },

  /**
   * Service Worker 업데이트 감시
   * - controllerchange: 새로운 Service Worker가 활성화되면 발생
   * - 페이지를 새로고침하도록 유저에게 알림
   */
  watchForUpdates() {
    if (!('serviceWorker' in navigator)) return

    // controllerchange: 새로운 Service Worker가 이 페이지를 제어하기 시작했을 때 발생
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('[SW] New Service Worker is now controlling the page')
      // 페이지에 update 배너를 표시하도록 신호를 보냄
      window.dispatchEvent(new CustomEvent('sw-update-available'))
    })

    // 이미 업데이트가 대기 중인지 확인
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      // controller가 이미 있다 = 활성 Service Worker가 있다
      // 업데이트 체크는 보통 주기적으로 자동으로 발생
      navigator.serviceWorker.ready.then(registration => {
        registration.addEventListener('updatefound', () => {
          console.log('[SW] Update found, new version downloading...')
          const newWorker = registration.installing
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
                console.log('[SW] New version activated')
                window.dispatchEvent(new CustomEvent('sw-update-available'))
              }
            })
          }
        })
      })
    }
  },

  /**
   * Service Worker 업데이트 확인 (수동)
   */
  async checkForUpdates() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[SW] Service Worker not supported')
      return
    }

    try {
      const registration = await navigator.serviceWorker.ready
      await registration.update()
      console.log('[SW] Update check completed')
    } catch (err) {
      console.error('[SW] Update check failed:', err)
    }
  }
}

export default SwRegistration
