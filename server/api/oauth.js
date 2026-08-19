// OAuth 2.1(PKCE) MCP 인증 — 기존 device_token 수동발급(pair-init/pair-approve, server/api/devices.js)
// 방식과 병행 유지되는 신규 발급 경로. 사전등록(트러스트) client_id 경로 + DCR(RFC 7591) 폴백을
// 함께 구현한다(대표 결정 — anthropics/claude-ai-mcp#359 오픈 버그 대응).
//
// mcp/device-auth.js(=/mcp 인증 검증 코드)는 이 파일과 무관하게 그대로 둔다 — 여기서 발급하는
// access_token도 결국 opaque token이고 device_tokens.token_hash에 SHA-256 해시로 저장되는 기존
// 구조를 그대로 재사용하기 때문이다.
//
// /token, /register는 OAuth/DCR 표준 프로토콜 엔드포인트라 RFC 6749/7591의 평평한 오류 형식
// ({error, error_description})을 그대로 따른다(임의의 MCP 클라이언트 라이브러리가 소비하므로
// 이 저장소의 {error:{code,message}} 응답 봉투를 강제하지 않는다). /authorize-context, /consent는
// 이 웹앱 프런트가 직접 호출하는 내부 API이므로 프로젝트 표준 응답 봉투를 그대로 쓴다.
import { Hono } from 'hono'
import * as oauthCodesDao from '../dao/oauth-authorization-codes.js'
import * as oauthClientsDao from '../dao/oauth-clients.js'
import * as oauthRefreshTokensDao from '../dao/oauth-refresh-tokens.js'
import * as deviceTokensDao from '../dao/device-tokens.js'
import * as auditLogsDao from '../dao/audit-logs.js'
import { newId } from '../lib/ulid.js'
import {
  generateOpaqueToken, sha256Hex, isValidPkceVerifierFormat, verifyPkceS256,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS, OAUTH_REFRESH_TOKEN_TTL_SECONDS
} from '../lib/tokens.js'
import { resolveTrustedClientName } from '../lib/oauth-trusted-clients.js'
import { isValidLoopbackRedirect } from '../lib/oauth-redirect-uri.js'
import { rotateOrDetectReuse } from '../lib/rotating-token.js'

/** client_id가 트러스트(사전등록) 또는 DCR 등록 클라이언트 어느 쪽인지 순서대로 확인하는 공용 헬퍼.
 *  트러스트가 우선 — env var와 일치하면 DCR 테이블 조회 자체를 생략한다. */
async function resolveClient(c, clientId) {
  const trustedName = resolveTrustedClientName(c.env, clientId)
  if (trustedName) return { trust: 'trusted', client_name: trustedName }

  const dcrClient = await oauthClientsDao.findById(c.env.DB, clientId)
  if (dcrClient) {
    return {
      trust: 'unverified',
      client_name: dcrClient.client_name,
      created_at: dcrClient.created_at,
      redirect_uris: JSON.parse(dcrClient.redirect_uris_json)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// well-known 2개 — /api 접두사가 없으므로 webApp 최상위에 직접 등록해야 한다(server/index.js).
// ---------------------------------------------------------------------------
export function registerWellKnownRoutes(app) {
  app.get('/.well-known/oauth-protected-resource', (c) => {
    const origin = new URL(c.req.url).origin
    return c.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
  })

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const origin = new URL(c.req.url).origin
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token']
    })
  })
}

// ---------------------------------------------------------------------------
// /api/oauth/* — server/index.js가 webApp.route('/api/oauth', oauthRouter)로 마운트.
// ---------------------------------------------------------------------------
const oauthRouter = new Hono()

// POST /api/oauth/register — 무인증(PUBLIC_PATHS), DCR(RFC 7591).
oauthRouter.post('/register', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const clientName = typeof body.client_name === 'string' ? body.client_name.trim() : null
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : null

  if (!redirectUris || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === 'string' && isValidLoopbackRedirect(u))) {
    return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array of valid loopback http://.../callback URIs' }, 400)
  }

  const created = await oauthClientsDao.insert(c.env.DB, { clientName, redirectUris })

  // actor_user_id는 NOT NULL이지만 DCR은 표준상 무인증 요청이라 실제 행위자가 없다 — 'system'
  // 고정 문자열로 기록한다(완료 보고에 판단 근거 명시).
  await auditLogsDao.record(c.env.DB, {
    actorUserId: 'system', action: 'oauth_client.registered', targetType: 'oauth_client', targetId: created.client_id,
    metadata: { client_name: clientName, redirect_uris: redirectUris }
  })

  return c.json({
    client_id: created.client_id,
    client_id_issued_at: Math.floor(new Date(created.created_at).getTime() / 1000),
    token_endpoint_auth_method: 'none',
    redirect_uris: redirectUris
  })
})

// RFC 6749 §3.2: 토큰 엔드포인트 요청은 application/x-www-form-urlencoded가 표준이다 — 실제
// OAuth 클라이언트(Claude Code 포함)는 이 형식으로 보내므로 JSON 전용 파싱은 표준 클라이언트를
// 전부 거부하는 결과가 된다(빈 body → grant_type undefined → unsupported_grant_type). content-type
// 기준으로 분기하고, 명시적 JSON이 아니면 form-urlencoded로 취급한다(스펙 기본값).
async function parseTokenRequestBody(c) {
  const contentType = c.req.header('content-type') || ''
  if (contentType.includes('application/json')) {
    return await c.req.json().catch(() => ({}))
  }
  const text = await c.req.text().catch(() => '')
  return Object.fromEntries(new URLSearchParams(text).entries())
}

// POST /api/oauth/token — 무인증(PUBLIC_PATHS). grant_type 분기.
oauthRouter.post('/token', async (c) => {
  const body = await parseTokenRequestBody(c)

  if (body.grant_type === 'authorization_code') {
    return handleAuthorizationCodeGrant(c, body)
  }
  if (body.grant_type === 'refresh_token') {
    return handleRefreshTokenGrant(c, body)
  }
  return c.json({ error: 'unsupported_grant_type', error_description: `grant_type must be authorization_code or refresh_token, got: ${body.grant_type ?? '(missing)'}` }, 400)
})

async function handleAuthorizationCodeGrant(c, body) {
  const code = typeof body.code === 'string' ? body.code : ''
  const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : ''
  const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : ''
  const clientId = typeof body.client_id === 'string' ? body.client_id : ''

  if (!code) {
    return c.json({ error: 'invalid_grant', error_description: 'code is required' }, 400)
  }

  const stored = await oauthCodesDao.findByCode(c.env.DB, code)
  if (!stored || new Date(stored.expires_at).getTime() < Date.now()) {
    return c.json({ error: 'invalid_grant', error_description: 'invalid or expired code' }, 400)
  }
  if (stored.client_id !== clientId || stored.redirect_uri !== redirectUri) {
    return c.json({ error: 'invalid_grant', error_description: 'client_id or redirect_uri mismatch' }, 400)
  }
  if (!isValidPkceVerifierFormat(codeVerifier)) {
    return c.json({ error: 'invalid_grant', error_description: 'invalid code_verifier format' }, 400)
  }
  if (!(await verifyPkceS256(codeVerifier, stored.code_challenge))) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
  }

  const consumed = await oauthCodesDao.consume(c.env.DB, code)
  if (!consumed) {
    // 레이스 또는 이미 소비된 code 재사용.
    return c.json({ error: 'invalid_grant', error_description: 'code already used' }, 400)
  }

  const rawAccessToken = generateOpaqueToken()
  const accessTokenHash = await sha256Hex(rawAccessToken)
  const accessExpiresAt = new Date(Date.now() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString()
  // device_id: OAuth 흐름엔 pair-init처럼 클라이언트가 미리 정하는 device_id가 없으므로, 이
  // 그랜트 전용 ULID를 새로 발급한다(client_id+userId 조합은 같은 유저가 같은 client_id로 여러
  // 물리 기기에서 인가할 때 서로 다른 기기를 같은 device_id로 뭉뚱그리게 되어 피한다).
  const deviceId = newId()
  const deviceToken = await deviceTokensDao.insert(c.env.DB, {
    userId: stored.user_id,
    deviceId,
    deviceName: stored.device_name,
    tokenHash: accessTokenHash,
    oauthClientId: stored.client_id,
    expiresAt: accessExpiresAt
  })

  const rawRefreshToken = generateOpaqueToken()
  const refreshTokenHash = await sha256Hex(rawRefreshToken)
  const refreshExpiresAt = new Date(Date.now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString()
  await oauthRefreshTokensDao.insert(c.env.DB, {
    deviceTokenId: deviceToken.id, tokenHash: refreshTokenHash, expiresAt: refreshExpiresAt
  })

  await auditLogsDao.record(c.env.DB, {
    actorUserId: stored.user_id, action: 'device_token.issued', targetType: 'device_token', targetId: deviceToken.id,
    metadata: { via: 'oauth', client_id: stored.client_id }
  })

  return c.json({
    access_token: rawAccessToken,
    refresh_token: rawRefreshToken,
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    token_type: 'Bearer'
  })
}

async function handleRefreshTokenGrant(c, body) {
  const rawRefreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : ''
  if (!rawRefreshToken) {
    return c.json({ error: 'invalid_grant', error_description: 'refresh_token is required' }, 400)
  }

  const tokenHash = await sha256Hex(rawRefreshToken)
  const result = await rotateOrDetectReuse(c.env.DB, tokenHash, {
    findByHash: oauthRefreshTokensDao.findByHash,
    markRotated: oauthRefreshTokensDao.markRotated,
    revokeAll: (db, stored, reason) => oauthRefreshTokensDao.revokeAllForDeviceToken(db, stored.device_token_id, reason)
  })

  if (!result.ok && result.reason === 'invalid') {
    return c.json({ error: 'invalid_grant' }, 401)
  }

  if (!result.ok && result.reason === 'reuse_detected') {
    // 탈취 판정 — 연결된 device_tokens는 이 디바이스 하나만 revoke(다른 디바이스는 건드리지 않음).
    const deviceTokenId = result.stored.device_token_id
    await deviceTokensDao.revoke(c.env.DB, deviceTokenId)
    const deviceToken = await deviceTokensDao.findById(c.env.DB, deviceTokenId)
    await auditLogsDao.record(c.env.DB, {
      actorUserId: deviceToken ? deviceToken.user_id : 'system',
      action: 'oauth_refresh_token.reuse_detected',
      targetType: 'device_token',
      targetId: deviceTokenId,
      metadata: { client_id: typeof body.client_id === 'string' ? body.client_id : null }
    })
    return c.json({ error: 'invalid_grant' }, 401)
  }

  const stored = result.stored
  const deviceToken = await deviceTokensDao.findById(c.env.DB, stored.device_token_id)
  if (!deviceToken || deviceToken.status !== 'active') {
    return c.json({ error: 'invalid_grant' }, 401)
  }

  const rawAccessToken = generateOpaqueToken()
  const accessTokenHash = await sha256Hex(rawAccessToken)
  const accessExpiresAt = new Date(Date.now() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString()
  await deviceTokensDao.rotateToken(c.env.DB, deviceToken.id, { tokenHash: accessTokenHash, expiresAt: accessExpiresAt })

  const rawRefreshTokenNew = generateOpaqueToken()
  const refreshTokenHashNew = await sha256Hex(rawRefreshTokenNew)
  const refreshExpiresAt = new Date(Date.now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString()
  await oauthRefreshTokensDao.insert(c.env.DB, {
    deviceTokenId: deviceToken.id, tokenHash: refreshTokenHashNew, expiresAt: refreshExpiresAt
  })

  return c.json({
    access_token: rawAccessToken,
    refresh_token: rawRefreshTokenNew,
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    token_type: 'Bearer'
  })
}

// POST /api/oauth/authorize-context — JWT 인증 필요. 프런트의 동의 화면이 client_id/redirect_uri를
// 렌더링하기 전에 신뢰 상태를 먼저 확인하는 용도.
oauthRouter.post('/authorize-context', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const clientId = typeof body.client_id === 'string' ? body.client_id : ''
  const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : ''

  if (!clientId) {
    return c.json({ error: { code: 'invalid_client', message: 'client_id is required' } }, 400)
  }
  const client = await resolveClient(c, clientId)
  if (!client) {
    return c.json({ error: { code: 'invalid_client', message: 'unknown client_id' } }, 400)
  }
  if (!isValidLoopbackRedirect(redirectUri)) {
    return c.json({ error: { code: 'invalid_redirect_uri', message: 'redirect_uri must be a valid loopback http://.../callback URI' } }, 400)
  }
  if (client.trust === 'unverified' && !client.redirect_uris.includes(redirectUri)) {
    return c.json({ error: { code: 'invalid_redirect_uri', message: 'redirect_uri not registered for this client' } }, 400)
  }

  if (client.trust === 'trusted') {
    return c.json({ client_name: client.client_name, trust: 'trusted' })
  }
  return c.json({ client_name: client.client_name, trust: 'unverified', registered_at: client.created_at })
})

// POST /api/oauth/consent — JWT 인증 필요. 신뢰 경계는 매 요청 독립 검증(authorize-context 결과를
// 세션에 캐싱해 재사용하지 않는다) — 아래도 위와 동일한 client_id/redirect_uri 재검증을 수행한다.
oauthRouter.post('/consent', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const clientId = typeof body.client_id === 'string' ? body.client_id : ''
  const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : ''
  const codeChallenge = typeof body.code_challenge === 'string' ? body.code_challenge : ''
  const codeChallengeMethod = typeof body.code_challenge_method === 'string' ? body.code_challenge_method : 'S256'
  const scope = typeof body.scope === 'string' ? body.scope : null
  const state = typeof body.state === 'string' ? body.state : ''
  const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : null

  if (!clientId) {
    return c.json({ error: { code: 'invalid_client', message: 'client_id is required' } }, 400)
  }
  const client = await resolveClient(c, clientId)
  if (!client) {
    return c.json({ error: { code: 'invalid_client', message: 'unknown client_id' } }, 400)
  }
  if (!isValidLoopbackRedirect(redirectUri)) {
    return c.json({ error: { code: 'invalid_redirect_uri', message: 'redirect_uri must be a valid loopback http://.../callback URI' } }, 400)
  }
  if (client.trust === 'unverified' && !client.redirect_uris.includes(redirectUri)) {
    return c.json({ error: { code: 'invalid_redirect_uri', message: 'redirect_uri not registered for this client' } }, 400)
  }
  if (codeChallengeMethod !== 'S256' || !codeChallenge) {
    return c.json({ error: { code: 'invalid_request', message: 'code_challenge (S256) is required' } }, 400)
  }

  const userId = c.get('userId')
  const created = await oauthCodesDao.insert(c.env.DB, {
    clientId, userId, redirectUri, codeChallenge, codeChallengeMethod, scope, deviceName
  })

  const redirectTo = `${redirectUri}?code=${encodeURIComponent(created.code)}&state=${encodeURIComponent(state)}`
  return c.json({ redirect_uri: redirectTo })
})

export default oauthRouter
