// GET /sso — 방문 즉시 Google 인터랙티브 로그인으로 넘어가는 자동 로그인 진입점(302).
// /sso는 /api/* 접두사가 없어 전역 jwtAuthMiddleware(server/middleware/jwt-auth.js, '/api/*'에만
// 부착)와 corsMiddleware를 애초에 타지 않는다 — PUBLIC_PATHS에는 추가하지 않는다(그 Set은 '/api/*'
// 경로만 비교 대상이라 '/sso'를 넣어도 아무 효과가 없고, 그 파일의 테스트 계약만 흔든다).
//
// server/api/oauth.js의 registerWellKnownRoutes()와 동일한 패턴 — /.well-known/oauth-*도 '/api'
// 접두사 없이 webApp 최상위에 절대경로로 직접 등록되는 라우트라, 같은 자리(server/index.js)에서
// 같은 방식으로 등록한다(서브라우터 webApp.route()가 아니라 함수 호출).
//
// ⚠️ 이 라우트가 실제로 동작하려면 아래 3곳이 모두 일치해야 한다 — 하나라도 어긋나면 500이 아니라
// text/html 200(정적 자산 SPA 폴백)으로 조용히 실패하고, 이를 잡아낼 테스트도 없다:
//   1) wrangler.jsonc의 assets.run_worker_first 배열에 '/sso'
//   2) server/index.js 최상위 디스패처의 url.pathname === '/sso' 분기
//   3) 아래 registerSsoRoute()의 app.get('/sso', ...) 등록
// 이 값은 server/api/auth-google.js의 REDIRECT_PATH_MAX_LENGTH(그 파일 상단 상수)와 반드시 같아야
// 한다. 그 파일 수정은 금지 범위 밖이라 import로 단일화하지 못하고 값을 복제한다 — 어느 한쪽만
// 바꾸면 이 라우트가 아직 유효하다고 보고 인코딩해 실어 보낸 redirect를 /start가 조용히 '/'로
// 버리는 불일치가 생긴다.
const REDIRECT_MAX_LENGTH = 512

function pathOnly(value) {
  // 값 뒤에 남은 ?query나 #hash를 잘라내고 트레일링 슬래시를 제거한 뒤 대소문자를 무시해 '/sso'와
  // 비교한다. '/ssomething'처럼 접두사만 같은 무관한 경로를 잘못 막지 않도록 split 후 전체 일치만
  // 본다(startsWith가 아니라 ===).
  return value.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase()
}

export function registerSsoRoute(app) {
  app.get('/sso', (c) => {
    const rawRedirect = c.req.query('redirect')

    // 값이 없거나 문자열이 아니면 파라미터 자체를 생략(서버 기본값 '/', /start가 담당).
    // silent 파라미터는 요청에 무엇이 실려 오든 절대 전달하지 않는다 — /sso는 항상 interactive다.
    let redirect = typeof rawRedirect === 'string' && rawRedirect ? rawRedirect : ''

    // 어차피 하류(/start의 sanitizeRedirectPath(), server/api/auth-google.js:52)가 512자 초과 값을
    // '/'로 버리므로, 여기서 미리 생략해 encodeURIComponent로 인한 Location 팽창(실측 최대 3배)을
    // 막는다. 거부하지 않고 파라미터만 생략하며 302는 그대로 정상 반환한다.
    if (redirect.length > REDIRECT_MAX_LENGTH) {
      redirect = ''
    }

    // 자기참조 방지 — /sso?redirect=/sso를 그대로 통과시키면 로그인 완료 후 이 값이 다시 /sso로
    // 돌아온다. 현재 구조에서는 이것이 무한 루프로 이어지지 않는다: login.vue:333의
    // this.$router.replace(target)은 클라이언트 라우팅이라 서버로 재요청을 보내지 않고,
    // app/pages/pages.json에 'sso' 라우트가 없어(SPA 라우트 테이블 밖) vue-zero의 catch-all이
    // 404 페이지를 렌더할 뿐 전체 리로드가 없다. 그래도 이 가드는 심층방어로 유지한다 — (a) 로그인
    // 후 404 대신 서버 기본값 '/'로 보내는 편이 사용자 경험상 낫고, (b) '/sso'가 다시 SPA 라우트로
    // 등록되거나 전체 페이지 리로드(예: window.location.assign)로 처리 방식이 바뀌면 루프가 실제로
    // 되살아날 수 있다.
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
    // 진입점이므로 no-store로 명시한다.
    c.header('Cache-Control', 'no-store')

    return c.redirect(location, 302)
  })
}
