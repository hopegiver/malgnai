<template>
  <div class="sso-wrap d-flex align-items-center justify-content-center min-vh-100">
    <div class="sso-skeleton d-flex flex-column align-items-center justify-content-center text-center">
      <div class="spinner-border text-primary mb-3" role="status">
        <span class="visually-hidden">로그인 중…</span>
      </div>
      <p class="text-muted small mb-0">로그인 중…</p>
      <!-- 리뷰 반영(4) — 이 앵커는 "JS 없이도 동작"하지 않는다(vue-zero는 이 파일 자체를
           런타임 fetch로 컴파일하므로 JS가 없거나 CDN이 막히면 이 마크업 자체가 렌더되지
           않는다). 실제 효용은 앱이 정상 마운트된 뒤 location.replace()만 동작하지 않은
           경우로 한정된다(login.vue의 8초 타임아웃 안전장치와 같은 실패 계열). 정상 이동 시
           눈에 스치지 않도록 짧은 지연 후에만 노출한다. -->
      <a
        v-if="showFallback"
        :href="fallbackHref"
        class="small mt-3"
      >자동으로 넘어가지 않으면 여기를 눌러 로그인</a>
    </div>
  </div>
</template>

<script>
// /sso — 북마크·링크로 방문하면 클릭 없이 즉시 Google 인터랙티브 로그인으로 넘어가는 자동
// 로그인 진입점(PM 지시서 "배경" 참고). 기존 무음 SSO(prompt=none) 인프라(login.vue)는 건드리지
// 않고, 그 위에 얹는 얇은 신규 페이지 하나다.
//
// 조건 없이 즉시 이동한다 — 기존 토큰 유효성 검사(login.vue의 hasValidToken())를 여기서
// 흉내내지 않기로 판단했다(구현 지시서 7번, 선택사항):
//   1) 지시서 3번이 "조건 없이 즉시" 이동을 명시하는데, 토큰 검사 분기를 넣으면 그 자체로
//      조건이 생겨 지시와 어긋난다.
//   2) 무한 루프 위험이 없다 — /api/auth/google/start는 로컬 세션을 보지 않고 항상 Google로
//      내보낸다. 이때 interactive 모드는 항상 prompt=select_account라서(server/lib/google-oidc.js:53
//      `url.searchParams.set('prompt', mode === 'silent' ? 'none' : 'select_account')`), 이미
//      Google에 로그인돼 있어도 방문마다 계정 선택 화면이 반드시 1회 뜬다 — "즉시 대시보드로
//      빠진다"는 아니지만, 콜백 이후 /login#gh= 교환을 거쳐 대시보드로 가지 /sso로 되돌아오는
//      코드 경로는 없다(server/api/auth-google.js).
//   3) /sso는 "방문하면 항상 인증 흐름을 탄다"는 단일 책임의 발사대 페이지로 두는 편이
//      login.vue의 판정 로직과 중복·드리프트를 만들지 않는다.
export default {
  // 가드 제외 + 레이아웃(사이드바) 없이 단독 렌더.
  layout: false,
  auth: false,
  title: '로그인 중… · malgnai-hub',
  data() {
    return {
      showFallback: false,
      fallbackHref: '/api/auth/google/start',
    }
  },
  mounted() {
    // 리뷰 반영(3) — login.vue의 goGoogleInteractive()와 같은 규약: 사용자의 가장 최근
    // 명시적 선택(=/sso 방문)이 항상 이기므로, 과거에 세운 무음 SSO 억제 마커를 해제한다.
    // 저장소 접근은 login.vue의 safeRemove()와 동일한 이유로 try/catch로 감싼다 — 저장소가
    // 차단된 환경에서 예외가 나면 아래 리다이렉트 자체가 죽는다.
    try {
      localStorage.removeItem('mh_g_silent_off')
    } catch {
      // no-op — 해제 실패는 무시하고 로그인 흐름은 계속 진행한다.
    }

    // SPA 라우터가 가로채지 않도록 top-level 이동. silent 파라미터는 절대 붙이지 않는다 —
    // /sso는 항상 interactive(로그인 UI가 필요하면 그대로 뜨는 흐름)여야 한다.
    // redirect 값 검증은 서버 sanitizeRedirectPath()가 전담하므로(구현 지시서), 여기서는
    // 인코딩만 하고 그대로 전달한다. 값이 없으면 파라미터 자체를 붙이지 않는다(서버 기본값 '/').
    //
    // 리뷰 반영(2) — 단, redirect가 /sso 자기 자신을 가리키면 예외적으로 여기서 직접 거른다.
    // 서버 sanitizeRedirectPath()는 문법(선행 '/', '..' 등)만 보고 의미(어디로 가는지)는
    // 보지 않아, /sso?redirect=/sso가 그대로 왕복되면 /start → Google → /login#gh= → exchange
    // (redirect_path 그대로 반환) → login.vue의 $router.replace('/sso') → 이 mounted()가 조건
    // 없이 재발사 → 무한 루프가 된다(login.vue는 건드리지 않으므로 이 파일에서 끊는다).
    let redirect = this.$route.query.redirect
    if (typeof redirect === 'string' && redirect) {
      const pathOnly = redirect.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase()
      if (pathOnly === '/sso') redirect = ''
    }
    const query = typeof redirect === 'string' && redirect
      ? '?redirect=' + encodeURIComponent(redirect)
      : ''
    this.fallbackHref = '/api/auth/google/start' + query

    window.location.replace(this.fallbackHref)

    // 정상적으로 이동하면 페이지가 파괴되어 이 타이머는 자연히 사라진다. 짧은 지연을 두는
    // 이유는 리다이렉트가 정상 동작하는(절대다수) 경우 화면에 앵커가 깜빡이며 스치지 않게
    // 하기 위함이다.
    setTimeout(() => {
      this.showFallback = true
    }, 1200)
  },
}
</script>

<style>
.sso-skeleton {
  min-height: 220px;
}
</style>
