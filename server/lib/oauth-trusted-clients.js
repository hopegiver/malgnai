// 사전등록(1차) 트러스트 OAuth 클라이언트 — malgn-agent 플러그인의 client_id를 env var
// TRUSTED_MALGN_AGENT_CLIENT_ID로 주입받아 여기서 단일 매핑한다. DCR(server/dao/oauth-clients.js)로
// 등록된 client는 이 경로를 타지 않고 "미검증(unverified)"으로 별도 취급한다(server/api/oauth.js 참고).
const TRUSTED_CLIENT_NAME = '맑은소프트 malgn-agent 플러그인'

/** env에 설정된 트러스트 client_id와 정확히 일치할 때만 표시용 이름을 반환, 아니면 null. */
export function resolveTrustedClientName(env, clientId) {
  if (!env.TRUSTED_MALGN_AGENT_CLIENT_ID || clientId !== env.TRUSTED_MALGN_AGENT_CLIENT_ID) return null
  return TRUSTED_CLIENT_NAME
}
