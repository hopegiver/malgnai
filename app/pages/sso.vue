<template>
  <div class="sso-wrap d-flex align-items-center justify-content-center min-vh-100">
    <div class="sso-skeleton d-flex flex-column align-items-center justify-content-center text-center">
      <div class="spinner-border text-primary mb-3" role="status">
        <span class="visually-hidden">로그인 중…</span>
      </div>
      <p class="text-muted small mb-0">로그인 중…</p>
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
//      내보내고, 이미 로그인된 사용자는 Google 세션이 남아있어 즉시 콜백 → /login#gh= 교환 →
//      대시보드로 빠지지 /sso로 되돌아오지 않는다(server/api/auth-google.js).
//   3) /sso는 "방문하면 항상 인증 흐름을 탄다"는 단일 책임의 발사대 페이지로 두는 편이
//      login.vue의 판정 로직과 중복·드리프트를 만들지 않는다.
export default {
  // 가드 제외 + 레이아웃(사이드바) 없이 단독 렌더.
  layout: false,
  auth: false,
  title: '로그인 중… · malgnai-hub',
  mounted() {
    // SPA 라우터가 가로채지 않도록 top-level 이동. silent 파라미터는 절대 붙이지 않는다 —
    // /sso는 항상 interactive(로그인 UI가 필요하면 그대로 뜨는 흐름)여야 한다.
    // redirect 값 검증은 서버 sanitizeRedirectPath()가 전담하므로(구현 지시서), 여기서는
    // 인코딩만 하고 그대로 전달한다. 값이 없으면 파라미터 자체를 붙이지 않는다(서버 기본값 '/').
    const redirect = this.$route.query.redirect
    const query = typeof redirect === 'string' && redirect
      ? '?redirect=' + encodeURIComponent(redirect)
      : ''
    window.location.replace('/api/auth/google/start' + query)
  },
}
</script>

<style>
.sso-skeleton {
  min-height: 220px;
}
</style>
