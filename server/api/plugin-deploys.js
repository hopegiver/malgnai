// POST /api/plugin-deploys/notify — claude-plugins CI(GitHub Actions)의 배포알림 인입.
// GET  /api/plugin-deploys        — 직원 조회(JWT, role 무관).
// 설계 정본: docs/design/plugin-deploy-notify.md. 두 라우트는 인증축이 다르다(§3.1) — 인입은
// requirePluginDeployKey(전역 JWT 게이트를 PUBLIC_PATHS로 우회, §3.2), 조회는 전역
// jwtAuthMiddleware가 이미 적용된 상태로 여기 도달한다(추가 미들웨어 불필요).
import { Hono } from 'hono'
import { requirePluginDeployKey } from '../middleware/plugin-deploy-key.js'
import * as pluginDeploysDao from '../dao/plugin-deploys.js'
import { syncCatalog } from '../lib/catalog-sync.js'

const pluginDeploys = new Hono()

const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,49}$/
// semver.org 공식 표현 그대로(§5.2) — 프리릴리스(1.9.0-rc.1)·빌드메타(1.9.0+build.5) 허용,
// 선행 0(01.2.3)과 'v' 접두사는 이 정규식이 자연히 거부한다.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
const COMMIT_HASH_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/
const REPO_SLUG_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/

const MAX_BODY_BYTES = 4096
const FUTURE_LIMIT_MS = 24 * 60 * 60 * 1000 // 24시간
const PAST_LIMIT_MS = 30 * 24 * 60 * 60 * 1000 // 30일
// ISO8601 with millis(예: '2026-09-10T08:12:44.311Z')가 24자 — 여유를 두되 임의로 큰 문자열이
// Date.parse의 관대한 파싱(예: 'Sep 10 2026 ... (' + 'a'.repeat(3000) + ')')을 통과해 그대로
// D1에 앉는 것을 막는다(security 정밀검토 m-2). Date.parse를 태우기 전에 이 길이부터 자른다.
const MAX_DEPLOYED_AT_LEN = 40

// security 정밀검토 M-1 — 같은 (plugin,version,commit)의 재시도만 막는 created 게이트 위에
// 얹는 전역 sync 쿨다운 창. 10분: 정상 트래픽(하루 0~수 회 배포)에서 같은 창 안에 서로 다른
// 배포 2건이 겹치는 일은 사실상 없고(같은 팀이 같은 시간대에 여러 플러그인을 연달아 릴리스하는
// 드문 경우에도 실질 손해는 "카탈로그 반영이 최대 10분 늦어짐"뿐 — cron이 어차피 1일 1회
// 회복한다), 공격 시나리오(요청당 ~104 GitHub 서브리퀘스트, 분당 10회 레이트리밋 허용치)에서는
// 시간당 GitHub 최대 소비를 6회×104=624회로 묶어 5,000/시간 한도 근처에도 못 가게 한다.
// 5~15분 범위 중 중간값을 택했다 — 더 짧으면(5분) 봉쇄 효과가 절반으로 줄고, 더 길면(15분)
// 정상 사용 시 카탈로그 반영 지연이 커진다.
const SYNC_COOLDOWN_MS = 10 * 60 * 1000

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100

/** 요청서상 호출자가 URL/SSH 형태로 보낼 수 있어 관대하게 받되 저장은 'owner/repo' 슬러그
 *  1형태로 정규화한다(§5.3). null=미제공(선택 필드), undefined=형식 오류(400) — 선택 필드라고
 *  잘못된 값을 조용히 버리면 호출자는 저장됐다고 믿고 우리는 NULL을 갖는 조용한 불일치가 생긴다. */
function normalizeRepository(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' || !raw.trim()) return null
  let v = raw.trim()
  v = v.replace(/^https?:\/\/(www\.)?github\.com\//i, '')
  v = v.replace(/^git@github\.com:/i, '')
  v = v.replace(/\.git$/i, '').replace(/\/+$/, '')
  return REPO_SLUG_RE.test(v) ? v : undefined
}

function badRequest(c, message) {
  return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400)
}

// D7 — 레이트리밋을 키 비교·본문 파싱·D1 접근보다 먼저 통과시킨다(§9.2). URL이 공개 저장소의
// 워크플로 YAML에 그대로 적히므로, 인증 실패도 이미 과금된 뒤라는 서버리스 특유의 이유다.
// 바인딩이 없는 환경(로컬·바인딩 반영 전)에서는 fail-open으로 통과시킨다(auth-google.js와 동일
// 방침) — 그래서 배포 후 이 바인딩이 실제로 붙었는지 확인이 필요하다(§15 체크10).
async function checkRateLimit(c) {
  const rl = c.env.PLUGIN_DEPLOY_RL
  if (!rl) return true
  const ip = c.req.header('cf-connecting-ip') || 'unknown'
  try {
    const { success } = await rl.limit({ key: `${ip}:plugin-deploy` })
    return success
  } catch (err) {
    // 레이트리밋 바인딩 자체 오류로 인입이 전면 막히면 안 된다 — 관측만 하고 통과시킨다.
    console.error('[plugin-deploy] rate limit check failed, allowing request', err)
    return true
  }
}

// ⚠️ security 정밀검토 m-3 — checkRateLimit()은 이 라우터에 **일괄 부착이 아니라 `/notify`
// 라우트 하나에만 인라인으로** 붙어 있다(바로 아래). 의도적 선택이다: 이 게이트(`PLUGIN_DEPLOY_RL`,
// IP당 분당 10회)는 CI 키 축(§4) 전용으로 설계됐고, `GET /`은 완전히 다른 신뢰 축(직원 JWT,
// role 무관, §6.5)이라 같은 한도를 씌우면 여러 직원이 같은 사무실 IP(NAT)에서 대시보드를 동시에
// 열었을 때 분당 10회에 걸려 조회 자체가 429로 막히는, 설계에 없던 회귀가 생긴다.
// **router.use('*', ...)로 승격시키지 말 것.** 대신: 이 라우터에 새 POST 라우트를 추가할 때는
// `checkRateLimit()`을 그 라우트에도 반드시 개별 부착해야 한다 — 구조적으로 누락되기 쉬운
// 지점이다(domain-serverless-edge-api-security "라우트별 개별부착 누락" 함정). 새 GET류(조회)
// 라우트는 이 게이트를 필요로 하지 않을 가능성이 높지만, 그 경우도 판단 근거를 주석으로 남길 것.
pluginDeploys.post('/notify', async (c, next) => {
  // 1) 레이트리밋(§8.2 순서1, §9.2)
  if (!(await checkRateLimit(c))) {
    c.header('Retry-After', '60')
    return c.json({ error: { code: 'RATE_LIMITED', message: 'too many deploy notifications' } }, 429)
  }
  await next()
}, requirePluginDeployKey, async (c) => {
  // 3) 본문 크기 상한 — Content-Length가 4096을 넘으면 파싱 전에 400(§5.1). 인증 전 단계에서
  // 큰 본문을 읽는 비용이 청구되지 않도록 키 검증(2단계) 뒤에도 파싱 전에 먼저 검사한다.
  // 이 사전검사는 "정직한 호출자"를 위한 빠른 조기차단일 뿐이다 — 헤더가 없거나(청크 전송)
  // 숫자가 아니면 Number(undefined||0)=0 / Number('abc')=NaN이 되어 통과해버린다(security
  // 정밀검토 m-1). 그래서 아래에서 실제로 읽은 바이트 길이로 한 번 더(권위 있게) 강제한다.
  const contentLength = Number(c.req.header('content-length') || 0)
  if (contentLength > MAX_BODY_BYTES) {
    return badRequest(c, `request body exceeds ${MAX_BODY_BYTES} bytes`)
  }

  // 4) JSON 파싱 + 필드 검증·정규화(§5). c.req.json()(내부적으로 스트림을 다 읽은 뒤 파싱) 대신
  // 실제 바이트를 먼저 받아 길이를 재검사한 뒤 파싱한다 — Content-Length 헤더의 유무·정직성에
  // 의존하지 않는다(m-1 처방: "파싱 후 크기 재검사 또는 arrayBuffer().byteLength 사용").
  let rawBytes
  try {
    rawBytes = await c.req.arrayBuffer()
  } catch {
    return badRequest(c, 'unable to read request body')
  }
  if (rawBytes.byteLength > MAX_BODY_BYTES) {
    return badRequest(c, `request body exceeds ${MAX_BODY_BYTES} bytes`)
  }

  let body
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes))
  } catch {
    body = null
  }
  if (!body || typeof body !== 'object') {
    return badRequest(c, 'request body must be a JSON object')
  }

  const pluginName = typeof body.plugin_name === 'string' ? body.plugin_name.trim() : ''
  if (!pluginName || !PLUGIN_NAME_RE.test(pluginName)) {
    return badRequest(c, 'plugin_name must match ^[a-z0-9][a-z0-9._-]{0,49}$')
  }

  const version = typeof body.version === 'string' ? body.version.trim() : ''
  if (!version || version.length > 64 || !SEMVER_RE.test(version)) {
    return badRequest(c, "version must be a valid semver (no 'v' prefix)")
  }

  const commitHashRaw = typeof body.commit_hash === 'string' ? body.commit_hash.trim().toLowerCase() : ''
  if (!commitHashRaw || !COMMIT_HASH_RE.test(commitHashRaw)) {
    return badRequest(c, 'commit_hash must be a 40 or 64 character lowercase hex string')
  }

  const repository = normalizeRepository(body.repository)
  if (repository === undefined) {
    return badRequest(c, 'repository must be an owner/repo slug or GitHub URL')
  }

  let deployedAt
  if (body.deployed_at !== undefined && body.deployed_at !== null) {
    const raw = typeof body.deployed_at === 'string' ? body.deployed_at.trim() : ''
    // 길이부터 자른다(security 정밀검토 m-2) — Date.parse는 관대해서 'Sep 10 2026 00:00:00
    // GMT+0000 (' + 'a'.repeat(3000) + ')' 같은 문자열도 통과시킨다. 설계 §5.1은 "ISO8601"이라고
    // 약속했으므로 길이 상한 없이 Date.parse만 통과시키는 것은 그 약속이 코드에 없는 상태였다.
    if (!raw || raw.length > MAX_DEPLOYED_AT_LEN) {
      return badRequest(c, `deployed_at must be an ISO8601 timestamp of at most ${MAX_DEPLOYED_AT_LEN} characters`)
    }
    const parsedMs = Date.parse(raw)
    if (!Number.isFinite(parsedMs)) {
      return badRequest(c, 'deployed_at must be a valid ISO8601 timestamp')
    }
    const now = Date.now()
    if (parsedMs > now + FUTURE_LIMIT_MS || parsedMs < now - PAST_LIMIT_MS) {
      return badRequest(c, 'deployed_at out of accepted range (max 24h future / 30d past)')
    }
    // 원문을 그대로 저장하지 않고 정규화한다(m-2) — Date.parse가 받아들이는 느슨한 형식(밀리초
    // 유무, 'Sep 10 2026 ...' 류)이 그대로 D1에 앉아 GET으로 전 직원에게 돌아가는 것을 막는다.
    deployedAt = new Date(parsedMs).toISOString()
  } else {
    deployedAt = null // 아래 5)에서 receivedAt으로 채운다.
  }

  // 5) received_at = 서버 시각. deployed_at 생략 시 received_at 값으로 채운다(NOT NULL 유지).
  const receivedAt = new Date().toISOString()
  if (deployedAt === null) deployedAt = receivedAt

  // 6) INSERT ... ON CONFLICT DO NOTHING RETURNING id — 멱등 지점(§8.2)
  const { created, row } = await pluginDeploysDao.insertIfAbsent(c.env.DB, {
    pluginName,
    version,
    commitHash: commitHashRaw,
    repository,
    deployedAt,
    receivedAt
  })

  // 커밋 해시 앞 7자는 git 관례상 공개 식별자이며 비밀이 아니다(§11.2). 헤더값·키 파생값은
  // 로그·응답 어디에도 담지 않는다.
  console.log('[plugin-deploy] accepted', { plugin: row.plugin_name, version: row.version, commit: row.commit_hash.slice(0, 7), created })

  // 7) created면 응답을 먼저 반환한 뒤 waitUntil로 카탈로그 재동기화(§2.3·§6.4) — 인라인으로
  // 돌리면 CI 요청이 느려지고 타임아웃→재시도→GitHub rate limit 403 증폭 경로가 열린다(cba03f3의
  // 사고). created===true 게이트는 **같은** (plugin,version,commit) 튜플의 재시도만 막는다 —
  // 공격자가 매 요청마다 version/commit_hash를 바꾸면 매번 새 행이 생겨 매번 이 게이트를
  // 통과한다(security 정밀검토 M-1, §2.3 원안의 "레이트리밋이 먼저 막는다"는 주장은 산술적으로
  // 틀렸다 — 카탈로그 스캔 대상 103개+tree 1회≈104 서브리퀘스트, 분당 10회 허용이면
  // 1,040req/분=62,400/시간으로 GITHUB_TOKEN 시간당 5,000 한도를 5분 내 소진한다).
  // 그래서 created 게이트 **위에** 전역 sync 쿨다운 게이트를 하나 더 얹는다 — (plugin,version,
  // commit) 튜플과 무관하게 "마지막으로 실제 sync를 건 시각"만 본다. 알림 수신 자체(2xx)는
  // 쿨다운에 걸려도 그대로 성공이다 — 이 게이트가 바꾸는 것은 부수효과(sync)뿐, 응답 계약이
  // 아니다.
  if (created) {
    const lastTriggeredAt = await pluginDeploysDao.getLastSyncTriggeredAt(c.env.DB)
    const lastTriggeredMs = lastTriggeredAt ? Date.parse(lastTriggeredAt) : null
    const nowMs = Date.parse(receivedAt)
    const withinCooldown = lastTriggeredMs !== null && Number.isFinite(lastTriggeredMs) && (nowMs - lastTriggeredMs) < SYNC_COOLDOWN_MS

    if (withinCooldown) {
      // 조용히 넘어가지 않는다 — 이상 증가(공격/버그로 쿨다운이 계속 걸리는 상황)를 관측할 수
      // 있어야 한다(요청서 지시).
      console.log('[plugin-deploy] catalog re-sync skipped (cooldown)', {
        plugin: row.plugin_name,
        version: row.version,
        msSinceLastTrigger: nowMs - lastTriggeredMs,
        cooldownMs: SYNC_COOLDOWN_MS
      })
    } else {
      // waitUntil로 넘기기 전에 동기적으로 트리거 시각을 먼저 기록한다 — 응답을 보낸 뒤에 적으면
      // 그 사이 도착한 동시 요청이 같은 "쿨다운 아님" 판정을 내려 이중 트리거될 창이 넓어진다.
      // D1은 요청 간 트랜잭션이 없어 완벽한 원자성은 아니지만(동시 요청이 이 read-then-write
      // 사이에 끼면 둘 다 트리거될 수 있다), 정상 트래픽(하루 0~수 회)에서는 이 창에 두 요청이
      // 동시에 들어올 동시성 자체가 없고, 공격 시나리오에서도 "쿨다운 창당 최대 1~2회"면
      // 봉쇄 목적(시간당 GitHub 소비를 5,000 한도 근처로 못 가게 함)은 그대로 달성된다.
      await pluginDeploysDao.markSyncTriggered(c.env.DB, row.id, receivedAt)
      c.executionCtx.waitUntil(
        syncCatalog(c.env.DB, c.env.GITHUB_TOKEN)
          .then((result) => console.log('[plugin-deploy] catalog re-sync done', JSON.stringify(result)))
          .catch((err) => console.error('[plugin-deploy] catalog re-sync failed', err))
      )
    }
  }

  // 8) 응답 — 재전송(200)일 때는 최초 수신 당시의 행 값 그대로(id·received_at 불변, §6.2).
  return c.json({
    accepted: true,
    created,
    id: row.id,
    plugin_name: row.plugin_name,
    version: row.version,
    commit_hash: row.commit_hash,
    received_at: row.received_at
  }, created ? 201 : 200)
})

pluginDeploys.get('/', async (c) => {
  // 전역 jwtAuthMiddleware가 이미 통과시킨 요청만 여기 도달한다(role 무관, GET /api/catalog와
  // 동일 정책, §6.5). '/api/plugin-deploys'는 PUBLIC_PATHS에 없으므로 JWT 없이는 이 핸들러 자체가
  // 호출되지 않는다 — jwt-auth.test.js/plugin-deploys.test.js의 회귀 테스트가 그 사실을 고정한다.
  const pluginParam = c.req.query('plugin')
  let pluginName
  if (pluginParam !== undefined) {
    pluginName = pluginParam.trim()
    if (!pluginName || !PLUGIN_NAME_RE.test(pluginName)) {
      return badRequest(c, 'plugin must match ^[a-z0-9][a-z0-9._-]{0,49}$')
    }
  }

  const limitParam = c.req.query('limit')
  let limit = DEFAULT_LIST_LIMIT
  if (limitParam !== undefined) {
    limit = Number(limitParam)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      return badRequest(c, `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`)
    }
  }

  const rows = await pluginDeploysDao.listRecent(c.env.DB, { pluginName, limit })
  return c.json({
    data: rows.map((row) => ({
      id: row.id,
      plugin_name: row.plugin_name,
      version: row.version,
      commit_hash: row.commit_hash,
      repository: row.repository,
      deployed_at: row.deployed_at,
      received_at: row.received_at
    }))
  })
})

export default pluginDeploys
