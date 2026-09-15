// GET /sso — 방문 즉시 Google 인터랙티브 로그인으로 넘어가는 자동 로그인 진입점(302).
// PM 지시서 "배경" 참고 — 원래 SPA 페이지(app/pages/sso.vue, feat/sso-auto-login 8b05487/492134c)로
// 구현했으나 리뷰로 Worker 302 라우트로 교체됐다. /sso는 /api/* 접두사가 없어 전역
// jwtAuthMiddleware(server/middleware/jwt-auth.js, '/api/*'에만 부착)와 corsMiddleware를 애초에
// 타지 않는다 — PUBLIC_PATHS에는 추가하지 않는다(그 Set은 '/api/*' 경로만 비교 대상이라 '/sso'를
// 넣어도 아무 효과가 없고, 그 파일의 테스트 계약만 흔든다).
//
// server/api/oauth.js의 registerWellKnownRoutes()와 동일한 패턴 — /.well-known/oauth-*도 '/api'
// 접두사 없이 webApp 최상위에 절대경로로 직접 등록되는 라우트라, 같은 자리(server/index.js)에서
// 같은 방식으로 등록한다(서브라우터 webApp.route()가 아니라 함수 호출).
function pathOnly(value) {
  // app/pages/sso.vue(삭제 전) mounted()의 자기참조 루프 판정을 그대로 이식 — 값 뒤에 남은
  // ?query나 #hash를 잘라내고 트레일링 슬래시를 제거한 뒤 대소문자를 무시해 '/sso'와 비교한다.
  // '/ssomething'처럼 접두사만 같은 무관한 경로를 잘못 막지 않도록 split 후 전체 일치만 본다
  // (startsWith가 아니라 ===).
  return value.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase()
}

export function registerSsoRoute(app) {
  app.get('/sso', (c) => {
    const rawRedirect = c.req.query('redirect')

    // 값이 없거나 문자열이 아니면 파라미터 자체를 생략(서버 기본값 '/', /start가 담당).
    // silent 파라미터는 요청에 무엇이 실려 오든 절대 전달하지 않는다 — /sso는 항상 interactive다.
    let redirect = typeof rawRedirect === 'string' && rawRedirect ? rawRedirect : ''

    // 자기참조 루프 차단(app/pages/sso.vue 리뷰 반영(2)과 동일 판정) — /sso?redirect=/sso가 그대로
    // 왕복되면 /start → Google → /login#gh= → exchange(redirect_path 그대로 반환,
    // server/api/auth-google.js:456) → login.vue의 $router.replace('/sso') → 이 라우트가 조건 없이
    // 재발사 → 무한 루프가 된다.
    if (redirect && pathOnly(redirect) === '/sso') {
      redirect = ''
    }

    // ⚠️ Location은 항상 고정 문자열 '/api/auth/google/start'로 시작한다 — 사용자 입력(redirect)은
    // 오직 ?redirect= 쿼리 값 자리에만, encodeURIComponent로 인코딩해 싣는다. 여기서 c.redirect()에
    // 넘기는 문자열 조립에 redirect 원문을 경로/오리진 자리에 넣지 않는 한 오픈 리다이렉트가 될 수
    // 없다(redirect 값의 상세 문법 검증 — 선행 '/', '..', 역슬래시 등 — 은 /start의
    // sanitizeRedirectPath()가 전담, server/api/auth-google.js:48).
    const location = '/api/auth/google/start' + (redirect ? '?redirect=' + encodeURIComponent(redirect) : '')

    // 302 응답이 브라우저/중간 캐시에 캐싱되면, 나중에 진입점 정책이 바뀌어도(예: /start 경로 자체를
    // 바꾸는 리팩터링) 낡은 Location으로 계속 보내질 수 있다 — 매 방문마다 새로 판정해야 하는 인증
    // 진입점이므로 no-store로 명시한다(이 저장소에 기존 전례는 없어 새로 판단, PM 지시서 요청사항).
    c.header('Cache-Control', 'no-store')

    return c.redirect(location, 302)
  })
}
