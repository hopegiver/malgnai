// Bearer device_token 검증 → { ok, identity } 반환. server/index.js의 /mcp 라우트에서 선행 검증하고,
// 검증 성공 시 ctx.props로 주입한다(architecture.md §2.3) — McpAgent 내부에서는 this.props로 읽는다.
// device_token 라우트(POST /api/sessions, v1 시간 되면 구현)에서도 재사용한다(§0 결정10).
import * as deviceTokensDao from '../server/dao/device-tokens.js'
import { sha256Hex } from '../server/lib/tokens.js'

export async function deviceAuthMiddleware(request, env) {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing bearer device token' }
  }
  const raw = authHeader.slice(7)
  const tokenHash = await sha256Hex(raw)
  const token = await deviceTokensDao.findActiveByHash(env.DB, tokenHash)
  if (!token) return { ok: false, reason: 'invalid or revoked device token' }
  if (token.expires_at && new Date(token.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'device token expired' }
  }
  // best-effort — last_used_at 갱신 실패가 인증 자체를 막지는 않는다.
  deviceTokensDao.touchLastUsed(env.DB, token.id).catch(() => {})
  return {
    ok: true,
    identity: { userId: token.user_id, deviceId: token.device_id, scopes: token.scopes }
  }
}
