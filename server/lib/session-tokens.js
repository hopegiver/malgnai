// 웹 세션(JWT + refresh token) 발급 — 자체인증(server/api/auth.js)과 Google 로그인
// (server/api/auth-google.js) 양쪽이 공유하는 단일 함수. docs/design/google-oauth-login.md 결정 5의
// 순수 추출 — server/api/auth.js의 로컬 함수였던 issueTokenPair(c, user)를 그대로 옮긴 것이며
// 로직·상수·DB 쓰기는 한 글자도 바뀌지 않았다(시그니처만 (c,user)→(env,user)로 변경, 호출부 1곳).
//
// 부작용은 refresh_tokens 1행 INSERT 하나뿐이고, 자체인증·Google 두 호출자 모두에게 동일하게
// 필요하다 — 호출자별로 달라야 하는 부작용은 없다(설계 결정 5 근거). JWT에 인증수단을 나타내는
// 클레임(amr 등)을 추가하지 않는다 — 소비자가 없고, 필요해지면 audit_logs(auth.google)로 사후 조회.
import * as refreshTokensDao from '../dao/refresh-tokens.js'
import { signAccessToken, generateOpaqueToken, sha256Hex, REFRESH_TOKEN_TTL_SECONDS } from './tokens.js'

export async function issueWebTokenPair(env, user) {
  const { token, expiresIn } = await signAccessToken(user, env.JWT_SECRET)
  const rawRefresh = generateOpaqueToken()
  const refreshHash = await sha256Hex(rawRefresh)
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString()
  await refreshTokensDao.insert(env.DB, { userId: user.id, tokenHash: refreshHash, expiresAt })
  return { token, expires_in: expiresIn, refresh_token: rawRefresh, refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS }
}
