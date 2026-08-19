// POST /api/sessions — 세션 요약 인입(OTel Collector 발신, architecture.md §7.1/§7.2, api.md §5.5).
// JWT가 아니라 device_token 인증이다(§0 결정10) — index.js의 jwtAuthMiddleware PUBLIC_PATHS에
// '/api/sessions'를 넣어 전역 JWT 게이트를 우회시키고, 이 라우트 안에서 mcp/device-auth.js의
// deviceAuthMiddleware를 직접 재사용해 Bearer device_token을 검증한다(그 파일 자체 주석이 이미
// 이 재사용을 예고하고 있었다).
//
// 처리 단계(§7.2 그대로): 검증 → 프로젝트 바인딩(get-or-create) → sessions UPSERT(멱등) →
// day_at 계산 → usage_daily CAS 재집계 → 200 { accepted: true } (Queue 없음, 요청 안에서 동기 처리).
import { Hono } from 'hono'
import { deviceAuthMiddleware } from '../../mcp/device-auth.js'
import * as projectsDao from '../dao/projects.js'
import * as sessionsDao from '../dao/sessions.js'
import { recomputeUsageDaily } from '../lib/usage-daily.js'
import { normalizeRepositoryKey } from '../lib/repository-key.js'
import { sha256Hex } from '../lib/tokens.js'

const sessions = new Hono()

const FUTURE_LIMIT_MS = 24 * 60 * 60 * 1000 // 24시간
const PAST_LIMIT_MS = 90 * 24 * 60 * 60 * 1000 // 90일
const MAX_SUMMARY_LEN = 120 // schema.sql §3.10 CHECK와 동일 캡

async function requireDeviceToken(c, next) {
  const authed = await deviceAuthMiddleware(c.req.raw, c.env)
  if (!authed.ok) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: authed.reason } }, 401)
  }
  // 클라이언트가 보내는 user_id/device_id는 신뢰하지 않는다 — device_token으로 확정한 값만 사용
  // (jwt-auth.js와 동일 house style, idea.md §12.3).
  c.set('deviceUserId', authed.identity.userId)
  c.set('deviceId', authed.identity.deviceId)
  await next()
}

function toNonNegativeInt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

sessions.post('/', requireDeviceToken, async (c) => {
  const body = await c.req.json().catch(() => ({}))

  const claudeSessionId = typeof body.claude_session_id === 'string' ? body.claude_session_id.trim() : ''
  if (!claudeSessionId) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'claude_session_id is required' } }, 400)
  }

  const startedAtRaw = typeof body.started_at === 'string' ? body.started_at.trim() : ''
  if (!startedAtRaw) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'started_at is required' } }, 400)
  }
  const startedAtMs = Date.parse(startedAtRaw)
  if (!Number.isFinite(startedAtMs)) {
    return c.json({ error: { code: 'STALE_OR_INVALID_TIMESTAMP', message: 'started_at is not a valid timestamp' } }, 422)
  }
  const now = Date.now()
  if (startedAtMs > now + FUTURE_LIMIT_MS || startedAtMs < now - PAST_LIMIT_MS) {
    // 시계 오차/버그 방어(§7.2 검증 1) — 24시간 초과 미래 또는 90일 초과 과거.
    return c.json({
      error: { code: 'STALE_OR_INVALID_TIMESTAMP', message: 'started_at out of accepted range (max 24h future / 90d past)' }
    }, 422)
  }

  const userId = c.get('deviceUserId')
  const deviceId = c.get('deviceId')

  // 프로젝트 바인딩(§7.2 2단계) — (user_id, repository_key) get-or-create, projects.js §4.1/§0 결정23과
  // 동일 흐름. repository_key 없으면(레포 밖 세션 등) project_id NULL 허용(schema.sql §3.10).
  let projectId = null
  const repositoryKeyRaw = typeof body.repository_key === 'string' ? body.repository_key : ''
  if (repositoryKeyRaw.trim()) {
    const repositoryKey = normalizeRepositoryKey(repositoryKeyRaw)
    const project = await projectsDao.getOrCreateForUser(c.env.DB, userId, repositoryKey)
    projectId = project.id
  }

  const id = await sha256Hex(`${deviceId}:${claudeSessionId}`)
  const endedAt = typeof body.ended_at === 'string' && body.ended_at.trim() ? body.ended_at.trim() : null
  const durationSeconds = body.duration_seconds !== undefined && body.duration_seconds !== null
    ? toNonNegativeInt(body.duration_seconds)
    : null
  const summary = typeof body.summary === 'string' && body.summary.trim()
    ? body.summary.trim().slice(0, MAX_SUMMARY_LEN)
    : null

  // 3. sessions UPSERT(멱등 — 같은 claude_session_id 재전송은 항상 같은 행에, 토큰 카운트는
  //    "최종 누적값"으로 덮어쓴다. §7.2 재시도 책임 문단).
  await sessionsDao.upsertFinal(c.env.DB, {
    id,
    projectId,
    userId,
    deviceId,
    pluginVersion: typeof body.plugin_version === 'string' ? body.plugin_version : null,
    claudeSessionId,
    startedAt: startedAtRaw,
    endedAt,
    durationSeconds,
    model: typeof body.model === 'string' ? body.model : null,
    inputTokens: toNonNegativeInt(body.input_tokens),
    outputTokens: toNonNegativeInt(body.output_tokens),
    cacheReadTokens: toNonNegativeInt(body.cache_read_tokens),
    cacheWriteTokens: toNonNegativeInt(body.cache_write_tokens),
    toolCalls: toNonNegativeInt(body.tool_calls),
    toolErrors: toNonNegativeInt(body.tool_errors),
    retries: toNonNegativeInt(body.retries),
    filesRead: toNonNegativeInt(body.files_read),
    filesChanged: toNonNegativeInt(body.files_changed),
    commits: toNonNegativeInt(body.commits),
    summary
  })

  // 4~5. day_at 계산 + usage_daily CAS 재집계(§7.2). 재집계 실패는 sessions 반영 자체를 되돌리지 않는다.
  const dayAt = startedAtRaw.slice(0, 10)
  await recomputeUsageDaily(c.env.DB, userId, dayAt)

  // 6. 응답 — D1 반영이 끝난 뒤 응답(Queue 없음, §0 결정19).
  return c.json({ accepted: true })
})

export default sessions
