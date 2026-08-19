// OAuth 2.1 네이티브 앱(Public Client) redirect_uri 검증 — RFC 8252 §7.3(루프백 IP 리다이렉션).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** http(s) 아닌 스킴, 루프백이 아닌 호스트, /callback이 아닌 경로는 전부 거부. */
export function isValidLoopbackRedirect(rawUri) {
  let u
  try {
    u = new URL(rawUri)
  } catch {
    return false
  }
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname) && u.pathname === '/callback'
  // 포트는 비교하지 않는다 — OS가 OAuth 클라이언트 실행마다 빈 로컬 포트를 임의로 고르기 때문(RFC 8252 §7.3).
}
