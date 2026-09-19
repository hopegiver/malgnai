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
  OAUTH_ACCESS_TOKEN_TTL_SECONDS, OAUTH_REFRESH_TOKEN_TTL_SECONDS, OAUTH_REUSE_GRACE_MS,
  REUSE_GRACE_MS
} from '../lib/tokens.js'
import { resolveTrustedClientName } from '../lib/oauth-trusted-clients.js'
import { isValidLoopbackRedirect } from '../lib/oauth-redirect-uri.js'
import { rotateOrDetectReuse, MCP_OAUTH_REFRESH_POLICY } from '../lib/rotating-token.js'

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

// ---------------------------------------------------------------------------
// /token 레이트 제한 — backend-dev 작업(레이트 제한 추가). 무인증 공개 경로이자 호출마다 D1
// 조회+sha256(성공 시 INSERT까지)을 하므로 남용이 곧 과금/DoS다(auth-google.js·plugin-deploys.js와
// 같은 우려, 그 두 파일 주석이 기록한 선례를 그대로 판단 재료로 쓴다). 다만 이 엔드포인트는 전
// 직원의 Claude Code 플러그인이 access_token TTL(8h)마다 refresh_token grant를 주기적으로
// 호출하고, 사무실은 NAT 뒤 공용 IP를 공유한다 — 두 그랜트에 똑같이 "IP 키" 축을 쓰면 사무실
// 전체의 정상 갱신이 서로를 막는 전사 MCP 장애가 된다(google-login M-E가 겪은 문제의 상위호환:
// M-E는 같은 사람의 두 요청이 부딪히는 것이었지만, 여기서는 서로 다른 사람들이 부딪힌다). 그래서
// 그랜트별로 키 축을 다르게 둔다:
//
// - authorization_code: `${ip}:authcode` 키(google-login과 동일 IP+scope 모델). 이 그랜트는
//   사람이 브라우저 동의를 마친 뒤 기기당 1회만 code를 교환하는 흐름이라(재발급 아님, 새 기기
//   페어링마다 1회) 같은 사무실에서 여러 사람이 "동시에" 이 그랜트를 호출할 확률은
//   refresh_token보다 훨씬 낮다 — google-login이 이미 이 위협모델(사무실 공용 IP)로 검증한
//   20/60 한도와 IP+scope 키를 그대로 재사용한다.
// - refresh_token: **IP가 아니라 제출된 refresh_token 원문의 해시**를 키로 쓴다(handleRefreshTokenGrant가
//   DB 조회에 쓰려고 이미 계산하는 tokenHash를 그대로 재사용 — 추가 해시 비용 없음). 이 축은
//   NAT 공유 문제를 임계값을 잘 추측해서 피하는 게 아니라 구조적으로 없앤다 — 직원마다 토큰
//   값이 전부 다르므로 서로 다른 직원의 요청이 같은 버킷을 절대 공유하지 않는다. 대가는:
//   이 축은 "같은 토큰을 반복 재생(replay)"하는 남용에는 강하지만, 매번 다른 무작위 문자열을
//   던지는 순수 물량 스팸에는 이 레이트리밋만으로 대응하지 못한다 — 다만 그런 요청은 이미
//   findByHash 인덱스 조회 1회(쓰기 없음, invalid_grant로 즉시 종료)라는 이 코드베이스의 다른
//   opaque-token 조회 엔드포인트(device-tokens 계열)와 동일한 비용 하한을 가지므로, 이번
//   범위(이 라우트 하나)에서 새로 만든 위험이 아니라 기존에 이미 감당하던 비용이다(범위 확대
//   금지 — 별도로 강화가 필요하면 docs/security-plan.md에 적어 둔다).
//
// 실패모드는 두 그랜트 모두 **fail-open**(바인딩 부재·오류 시 통과) — google-login/plugin-deploys와
// 같은 이유이되 이 라우트는 그 위험이 더 크다: 이 게이트가 fail-closed로 막히면 "로그인 1건"이
// 아니라 "전 직원의 MCP 세션 전체"가 죽는다(email_send의 fail-closed와는 정반대 위험 프로파일 —
// 이메일은 안 나가도 서비스가 안 죽지만, 이 엔드포인트가 막히면 서비스 자체가 죽는다). limit 값
// (20/60)은 google-login과 같은 값을 재사용한다 — 정확한 임계값은(google-login M-E 주석과 동일한
// 사유로) 실제 프로덕션 트래픽 없이는 검증할 수 없다.
async function checkOauthTokenRateLimit(c, key) {
  const rl = c.env.OAUTH_TOKEN_RL
  if (!rl) return true
  try {
    const { success } = await rl.limit({ key })
    return success
  } catch (err) {
    // 레이트리밋 바인딩 자체 오류로 토큰 발급/갱신이 전면 막히면 안 된다 — 관측만 하고 통과시킨다.
    console.error('[oauth] rate limit check failed, allowing request', err)
    return true
  }
}

// RFC 8628(§3.5)의 slow_down을 차용한다 — RFC 6749 §5.2는 "너무 자주 호출했다"에 대응하는
// 표준 에러 코드를 정의하지 않지만, slow_down은 이미 OAuth 생태계(디바이스 그랜트 폴링)에서
// "그랜트는 유효하나 속도를 늦춰야 한다"는 의미로 통용되는 값이라 invalid_grant(자격 자체가
// 잘못됐다는 의미)로 오독되지 않는다. 파일 상단 주석대로 /token은 평평한 {error,
// error_description} 형식을 유지한다.
function oauthRateLimitedResponse(c) {
  c.header('Retry-After', '60')
  return c.json({ error: 'slow_down', error_description: 'too many token requests, retry later' }, 429)
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
  // 레이트리밋을 D1 조회(findByCode) 이전, 가장 먼저 확인한다 — 무작위 code 대입 시도의 비용을
  // 최대한 이른 시점에서 끊는다.
  const ip = c.req.header('cf-connecting-ip') || 'unknown'
  if (!(await checkOauthTokenRateLimit(c, `${ip}:authcode`))) {
    return oauthRateLimitedResponse(c)
  }

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

  // 레이트리밋 — IP가 아니라 이 요청이 제시한 토큰의 해시가 키다(파일 상단 주석 참고). DB 조회
  // (rotateOrDetectReuse → findByHash) 이전에 확인해, 같은 토큰을 반복 재생하는 남용의 D1 비용을
  // 끊는다. tokenHash는 아래 findByHash에도 그대로 재사용되므로 추가 계산 비용이 없다.
  if (!(await checkOauthTokenRateLimit(c, `${tokenHash}:refresh`))) {
    return oauthRateLimitedResponse(c)
  }

  const result = await rotateOrDetectReuse(c.env.DB, tokenHash, {
    findByHash: oauthRefreshTokensDao.findByHash,
    markRotated: oauthRefreshTokensDao.markRotated,
    revokeAll: (db, stored, reason) =>
      oauthRefreshTokensDao.revokeAllForDeviceToken(db, stored.device_token_id, reason)
  }, MCP_OAUTH_REFRESH_POLICY) // ← 4번째 인자만 추가. dao 어댑터는 그대로(설계 §5.1).

  if (!result.ok && result.reason === 'invalid') {
    return c.json({ error: 'invalid_grant' }, 401)
  }
  if (!result.ok) {
    // reuse_detected | stale_reuse | already_revoked — 와이어 응답은 셋 다 동일(401 invalid_grant).
    // 클라이언트가 세 경우를 구분할 수 없어야 한다(판정 경계 탐색 방지). 구분은 감사로그에만 남긴다.
    const deviceTokenId = result.stored.device_token_id
    if (result.reason === 'reuse_detected') {
      await deviceTokensDao.revoke(c.env.DB, deviceTokenId) // 가족 폐기일 때만 device_token도 폐기
    }
    const deviceToken = await deviceTokensDao.findById(c.env.DB, deviceTokenId)
    await auditLogsDao.record(c.env.DB, {
      actorUserId: deviceToken ? deviceToken.user_id : 'system',
      action: 'oauth_refresh_token.reuse_detected', // ← CHECK 화이트리스트 기존 값 그대로(§10)
      targetType: 'device_token',
      targetId: deviceTokenId,
      metadata: {
        client_id: typeof body.client_id === 'string' ? body.client_id : null,
        outcome: result.reason === 'reuse_detected' ? 'family_revoked'
          : result.reason === 'stale_reuse' ? 'rejected_only' : 'already_revoked',
        stale_age_ms: Number.isFinite(result.staleAgeMs) ? Math.round(result.staleAgeMs) : null,
        refresh_token_id: result.stored.id, // 토큰이 아니라 행 ULID — 자격증명 아님
        grace_ms: OAUTH_REUSE_GRACE_MS,
        policy: MCP_OAUTH_REFRESH_POLICY.label // reviewer 리뷰 m2 — 죽은 필드였던 policy.label을 감사에 싣는다
      }
    })
    return c.json({ error: 'invalid_grant' }, 401)
  }

  const stored = result.stored
  const deviceToken = await deviceTokensDao.findById(c.env.DB, stored.device_token_id)

  // security 리뷰 H1: grace로 통과한 교환 중 웹 grace(REUSE_GRACE_MS=10초)를 넘긴 것만 감사에
  // 남긴다 — 10초 이내 동시요청은 기존에도 정상이고 양이 많아 신호를 익사시키지 않는다. 이 구간
  // (10초~10분)이 바로 이번 완화가 새로 허용한 교환이며, 여태 무기록이었다(설계 §15 R-2가 이
  // 값을 실측으로 재조정하려면 이 로그가 있어야 한다). action은 CHECK 화이트리스트 기존 값을
  // 재사용하고(마이그레이션 불필요), 구분은 outcome으로만 한다 — 실패 경로 메타데이터와 필드
  // 이름·의미를 통일한다.
  if (result.path === 'grace' && result.staleAgeMs > REUSE_GRACE_MS) {
    await auditLogsDao.record(c.env.DB, {
      actorUserId: deviceToken ? deviceToken.user_id : 'system',
      action: 'oauth_refresh_token.reuse_detected',
      targetType: 'device_token',
      targetId: stored.device_token_id,
      metadata: {
        client_id: typeof body.client_id === 'string' ? body.client_id : null,
        outcome: 'grace_allowed',
        stale_age_ms: Math.round(result.staleAgeMs),
        refresh_token_id: stored.id, // 토큰이 아니라 행 ULID — 자격증명 아님
        grace_ms: OAUTH_REUSE_GRACE_MS,
        policy: MCP_OAUTH_REFRESH_POLICY.label,
        src_ip: c.req.header('cf-connecting-ip') || null
      }
    })
  }

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
