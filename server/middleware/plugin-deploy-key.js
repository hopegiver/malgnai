// CI 키 인증 미들웨어 — claude-plugins GitHub Actions가 플러그인 배포를 알리는 제3의 인증축
// (사람 JWT도 디바이스 토큰도 아니다, docs/design/plugin-deploy-notify.md §4). 사용자가 없는
// 호출이라 c.set('userId', …) 같은 컨텍스트 주입은 하지 않는다 — 기록되는 것은 "유효한 키를
// 쥔 누군가가 이 사실을 알려왔다"뿐이다.
import { timingSafeEqualSecret } from '../lib/tokens.js'

// 자리표시자·짧은 임시값이 실운영 자격증명이 되는 사고를 구조적으로 차단(§4.5).
const MIN_KEY_LENGTH = 32

export async function requirePluginDeployKey(c, next) {
  const configured = c.env.PLUGIN_DEPLOY_KEY
  // fail-closed — 미설정을 "통과"로 해석하는 경로는 존재하지 않는다(jwt-auth.js:36-38과 동일 방침).
  // 401이 아니라 500으로 낸다: 401은 "네 자격증명이 틀렸다"는 뜻이라 CI 담당자를 잘못된 방향으로
  // 보낸다(jwt-auth.js의 JWT_SECRET 미설정 처리와 동일 근거).
  if (!configured || configured.length < MIN_KEY_LENGTH) {
    console.error('[plugin-deploy] PLUGIN_DEPLOY_KEY missing or too short — rejecting') // 값·실제 길이는 절대 찍지 않는다
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'plugin deploy key not configured' } }, 500)
  }

  const provided = c.req.header('X-Plugin-Deploy-Key')
  if (!provided) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'missing X-Plugin-Deploy-Key header' } }, 401)
  }

  if (!(await timingSafeEqualSecret(provided, configured))) {
    // 제공된 값을 로그·응답 어디에도 싣지 않는다(부분 문자열·길이·해시 전부 금지) — "헤더 없음"과
    // "키 불일치"를 다른 message로 구분하는 것(jwt-auth.js:42,54와 동일 이유 — 사내 CI 연동
    // 디버깅에 필요하며 열거에 도움될 정보가 아니다)만 허용한다. code는 둘 다 UNAUTHORIZED.
    console.warn('[plugin-deploy] invalid deploy key', { ip: c.req.header('cf-connecting-ip') || 'unknown' })
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'invalid deploy key' } }, 401)
  }

  await next()
}
