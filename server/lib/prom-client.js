// Prometheus(Grafana datasource proxy) HTTP 클라이언트 — 전송·캐시·장애 처리만 담당하고 PromQL은
// 모른다(docs/design/usage-prometheus-realtime.md §3 모듈 경계 원칙). 표현식 조립은
// server/lib/usage-prom.js가 맡고, 이 모듈은 그 표현식 문자열을 받아 질의만 실행한다.
//
// 안전 임계값(타임아웃·TTL·재시도·회로차단) 정본 — 값을 바꿀 때는 이 파일 한 곳만 고치면 된다
// (설계 §9.1/§7.3 "다른 파일에 복사하지 말 것").
//
// rev.2(하이브리드) — 요청 경로(live)와 Cron 적재 경로(cron)는 타임아웃이 다르다(§9.1). 이 사실
// 자체가 함정이라 밀리초 숫자를 호출부에 흩뿌리지 않고 spec.profile:'live'|'cron' → 아래
// PROFILE_TIMEOUTS 매핑 한 곳으로만 해석한다(queryProm 참고).
export const PROM_QUERY_TIMEOUT_MS = 8000 // rev.1: 5000. 콜드 편차(웜 1.06s/콜드 6.0s) 실측 근거 §9.1
export const PROM_SERVER_TIMEOUT_QS = '7s' // rev.1: '4s'. 클라이언트보다 1초 짧게(상류가 먼저 포기)
export const PROM_ROUTE_BUDGET_MS = 12000 // rev.1: 9000. 웨이브 2회(8s+α) + 재시도 여유
export const PROM_RETRY_MAX = 1
export const PROM_RETRY_DELAY_MS = 250
export const PROM_CACHE_TTL_SECONDS = 60
export const PROM_STALE_MAX_AGE_SECONDS = 600
export const PROM_CACHE_VERSION = 'v1'
export const PROM_MAX_WAVE_SIZE = 3
// Cron 적재 경로 전용(신규, §9.1) — 7일 query_range 실측 5.0초 + 콜드 편차 여유. 상류가 30초에서
// 스스로 죽으므로 그보다 앞서 끊는다. 요청 경로(PROM_QUERY_TIMEOUT_MS)와 절대 혼동하지 말 것 —
// server/lib/usage-rollup.js·usage-prom.js의 fetchCompletedDayGrid가 spec.profile:'cron'으로만
// 이 값을 쓴다(호출부에 밀리초를 복사하지 않는다).
export const PROM_CRON_QUERY_TIMEOUT_MS = 25000
export const PROM_CRON_SERVER_TIMEOUT_QS = '20s'
export const PROM_REFRESH_THROTTLE_MS = 10000
export const PROM_CIRCUIT_FAILURE_THRESHOLD = 3
export const PROM_CIRCUIT_OPEN_MS = 30000
const L1_MAX_ENTRIES = 50

/** 상류 실패를 라우트 에러 매핑(설계 §9.3)으로 그대로 옮길 수 있는 표준 에러. `reason`은
 *  not_configured|timeout|auth|upstream_error|invalid_response|circuit_open|insecure_scheme|
 *  invalid_upstream_url 중 하나(마지막 둘은 Cloudflare Tunnel 채택에 따른 https fail-closed 신규 —
 *  아래 STATIC_CONFIG_ERROR_REASONS 참고). */
export class UpstreamError extends Error {
  constructor(reason, message) {
    super(message || `upstream unavailable: ${reason}`)
    this.name = 'UpstreamError'
    this.reason = reason
  }
}

// GRAFANA_BASE_URL 스킴 검증(사람 승인 결정 2, Cloudflare Tunnel 채택에 따른 fail-closed) — 정적
// 설정 오류이지 상류 건강 상태와 무관하므로 not_configured와 동일하게 회로차단 카운터에서 제외한다
// (queryProm의 두 실패 경로가 이 Set 하나만 본다 — 새 정적 오류 reason을 추가할 때는 여기만 고치면 됨).
const STATIC_CONFIG_ERROR_REASONS = new Set(['not_configured', 'insecure_scheme', 'invalid_upstream_url'])

/** GRAFANA_BASE_URL의 스킴을 검증 — https가 아니면 기본적으로 fail-closed(요청을 상류로 보내지
 *  않고 즉시 실패)한다. 로컬 개발(`wrangler dev`)만 `.dev.vars`의 `GRAFANA_ALLOW_INSECURE_HTTP=true`로
 *  명시적으로 이 검증을 우회한다 — 프로덕션은 이 값을 설정하지 않으므로(설정 자체가 없음) 별도의
 *  "지금 프로덕션인가"라는 환경 판정 없이도 "기본값 = 안전"이 구조적으로 보장된다(`wrangler.jsonc`에
 *  vars를 추가하지 않고도 되돌릴 수 없는 안전 기본값을 얻는 설계 — 이 파일이 유일한 정본).
 *  호스트명은 여전히 어디에도 하드코딩하지 않는다(§S1b) — 여기서는 스킴만 본다. */
export function validateUpstreamScheme(env, baseUrl) {
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new UpstreamError('invalid_upstream_url', 'GRAFANA_BASE_URL is not a valid absolute URL')
  }
  if (parsed.protocol === 'https:') return
  if (env.GRAFANA_ALLOW_INSECURE_HTTP === 'true') return
  throw new UpstreamError('insecure_scheme', `GRAFANA_BASE_URL must use https (got ${parsed.protocol.replace(':', '')}) — set GRAFANA_ALLOW_INSECURE_HTTP=true for local dev only`)
}

// ---------------------------------------------------------------------------
// L1(isolate 모듈 스코프 Map) + L2(Cache API) 2계층 캐시(설계 §7.2). best-effort — isolate는
// 수명이 짧고 여러 개가 동시에 존재하므로 완벽한 일관성을 보장하지 않는다.
// ---------------------------------------------------------------------------
const l1Cache = new Map() // key -> { data, fetchedAt(ms) }
const inFlight = new Map() // key -> Promise<{data, fetchedAt}>
let lastForcedFetchAt = 0
// isolate 로컬 회로차단(설계 §9.5) — 상류 보호가 아니라 "죽은 상류에 매 요청 5초씩 매달리는 것"
// 방지가 목적이다. half-open 없이 단순화: 성공 1회로 즉시 닫힌다.
const circuit = { consecutiveFailures: 0, openUntil: 0 }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function l1Get(key) {
  return l1Cache.get(key)
}

function l1Set(key, entry) {
  if (!l1Cache.has(key) && l1Cache.size >= L1_MAX_ENTRIES) {
    const oldestKey = l1Cache.keys().next().value
    l1Cache.delete(oldestKey)
  }
  l1Cache.delete(key)
  l1Cache.set(key, entry) // Map은 삽입 순서를 보존하므로 재삽입으로 "최근 사용"을 뒤로 민다.
}

function l2Url(key) {
  // caches.default는 Request/Response 쌍만 저장하므로 캐시 키를 합성 URL로 감싼다(GET 전용).
  return `https://usage-prom.internal/${encodeURIComponent(key)}`
}

async function l2Get(key) {
  try {
    const res = await caches.default.match(l2Url(key))
    if (!res) return null
    const fetchedAtHeader = res.headers.get('x-fetched-at')
    const fetchedAt = fetchedAtHeader ? Number(fetchedAtHeader) : NaN
    if (!Number.isFinite(fetchedAt)) return null
    const data = await res.json()
    return { data, fetchedAt }
  } catch (err) {
    // workers.dev 등에서 Cache API가 무동작일 수 있다(설계 §7.2 R7) — L1만으로 기능은 성립하므로 무시.
    console.error('[prom-client] L2 cache read failed (ignored)', err)
    return null
  }
}

async function l2Set(key, entry) {
  try {
    const res = new Response(JSON.stringify(entry.data), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${PROM_STALE_MAX_AGE_SECONDS}`,
        'x-fetched-at': String(entry.fetchedAt)
      }
    })
    await caches.default.put(l2Url(key), res)
  } catch (err) {
    console.error('[prom-client] L2 cache write failed (ignored)', err)
  }
}

async function buildCacheKey({ aggMode, queryType, expr, time, start, end, step }) {
  const exprHash = await sha256HexLocal(expr || '')
  return [
    'usage-prom', PROM_CACHE_VERSION, aggMode, queryType, exprHash,
    start ?? time ?? '', end ?? '', step ?? ''
  ].join(':')
}

// tokens.js의 sha256Hex와 동일 구현 — server/lib 간 순환 의존을 만들지 않기 위해 로컬에 둔다
// (prom-client는 인증 모듈에 의존하지 않는다는 경계를 유지).
async function sha256HexLocal(raw) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function freshResult(entry, now, { fromCache, refreshThrottled }) {
  return {
    data: entry.data,
    meta: {
      hit: !!fromCache,
      age_seconds: Math.max(0, Math.round((now - entry.fetchedAt) / 1000)),
      ttl_seconds: PROM_CACHE_TTL_SECONDS,
      stale: false,
      fetched_at: new Date(entry.fetchedAt).toISOString(),
      refresh_throttled: !!refreshThrottled
    }
  }
}

function staleResult(entry, now) {
  return {
    data: entry.data,
    meta: {
      hit: true,
      age_seconds: Math.max(0, Math.round((now - entry.fetchedAt) / 1000)),
      ttl_seconds: PROM_CACHE_TTL_SECONDS,
      stale: true,
      fetched_at: new Date(entry.fetchedAt).toISOString(),
      refresh_throttled: false
    }
  }
}

async function fallbackOrThrow(key, now, reason) {
  const l1 = l1Get(key)
  if (l1 && now - l1.fetchedAt < PROM_STALE_MAX_AGE_SECONDS * 1000) {
    return staleResult(l1, now)
  }
  const l2 = await l2Get(key)
  if (l2 && now - l2.fetchedAt < PROM_STALE_MAX_AGE_SECONDS * 1000) {
    l1Set(key, l2)
    return staleResult(l2, now)
  }
  throw new UpstreamError(reason)
}

// ---------------------------------------------------------------------------
// 프로필→타임아웃 매핑(설계 §9.1 정본 — "호출부에 밀리초 숫자가 등장하면 정본이 둘이 된다").
// queryProm(env, spec)의 spec.profile만 보고 이 표 하나로 해석한다.
// ---------------------------------------------------------------------------
const PROFILE_TIMEOUTS = {
  live: { queryTimeoutMs: PROM_QUERY_TIMEOUT_MS, serverTimeoutQs: PROM_SERVER_TIMEOUT_QS },
  cron: { queryTimeoutMs: PROM_CRON_QUERY_TIMEOUT_MS, serverTimeoutQs: PROM_CRON_SERVER_TIMEOUT_QS }
}

// ---------------------------------------------------------------------------
// 상류 HTTP 호출 — 재시도(§9.2)와 상태코드→reason 매핑(§9.3)
// ---------------------------------------------------------------------------
function buildProxyUrl(baseUrl, uid, queryType, { expr, time, start, end, step }, serverTimeoutQs) {
  const url = new URL(`/api/datasources/proxy/uid/${uid}/api/v1/${queryType}`, baseUrl)
  url.searchParams.set('query', expr)
  url.searchParams.set('timeout', serverTimeoutQs)
  if (queryType === 'query') {
    if (time !== undefined) url.searchParams.set('time', String(time))
  } else if (queryType === 'query_range') {
    url.searchParams.set('start', String(start))
    url.searchParams.set('end', String(end))
    url.searchParams.set('step', String(step))
  }
  return url
}

async function attemptFetch(url, token, queryTimeoutMs) {
  let res
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(queryTimeoutMs)
    })
  } catch (err) {
    const e = new UpstreamError('timeout', err && err.message)
    e.retryable = true
    throw e
  }

  if (res.status === 401 || res.status === 403) {
    const e = new UpstreamError('auth', `grafana auth failed: ${res.status}`)
    e.retryable = false // 4xx는 재시도해도 같은 결과이고 상류만 때린다(§9.2)
    throw e
  }
  if (res.status === 404) {
    const e = new UpstreamError('upstream_error', 'grafana proxy route not found')
    e.retryable = false
    throw e
  }
  if (!res.ok) {
    const e = new UpstreamError('upstream_error', `grafana http ${res.status}`)
    e.retryable = res.status >= 500 || res.status === 429
    throw e
  }

  let body
  try {
    body = await res.json()
  } catch {
    const e = new UpstreamError('invalid_response', 'grafana response is not valid json')
    e.retryable = false
    throw e
  }
  if (!body || body.status !== 'success' || !body.data || !Array.isArray(body.data.result)) {
    const e = new UpstreamError('upstream_error', 'prometheus query returned error status')
    e.retryable = false
    throw e
  }
  // Prometheus HTTP API의 실제 페이로드는 data.result(vector|matrix 시계열 배열)에 있다
  // (data 자체는 {resultType, result} 래퍼) — usage-prom.js는 이 배열만 소비한다.
  return body.data.result
}

async function fetchFromUpstream(env, queryType, params, timeouts) {
  const baseUrl = env.GRAFANA_BASE_URL
  const uid = env.GRAFANA_PROM_DATASOURCE_UID
  const token = env.GRAFANA_API_TOKEN
  if (!baseUrl || !uid || !token) {
    throw new UpstreamError('not_configured', 'Grafana usage query is not configured')
  }
  validateUpstreamScheme(env, baseUrl) // 결정2 — 상류로 나가기 전에 검증(요청 자체를 만들지 않는다)

  const url = buildProxyUrl(baseUrl, uid, queryType, params, timeouts.serverTimeoutQs)

  let lastErr = null
  for (let attempt = 0; attempt <= PROM_RETRY_MAX; attempt++) {
    if (attempt > 0) await sleep(PROM_RETRY_DELAY_MS)
    try {
      return await attemptFetch(url, token, timeouts.queryTimeoutMs)
    } catch (err) {
      lastErr = err
      if (!err.retryable || attempt >= PROM_RETRY_MAX) throw err
    }
  }
  throw lastErr
}

/** 질의 1건 실행 — 캐시(L1/L2)→회로차단→요청병합(coalescing)→상류 호출→실패시 stale 폴백 순.
 *  spec: { aggMode, queryType:'query'|'query_range', expr, time?, start?, end?, step?, refresh?,
 *          profile?:'live'|'cron'(기본 live), bypassCache?, skipCircuit? }
 *  bypassCache/skipCircuit=true(Cron 적재 전용, 설계 §9.1 격리 규칙)면 L1/L2 캐시를 읽지도 쓰지도
 *  않고 회로차단 상태도 건드리지 않는다 — 무거운 적재 질의가 가벼운 라이브 경로의 캐시·회로를
 *  오염시키지 않게 하기 위함. */
export async function queryProm(env, spec) {
  const { queryType, expr, time, start, end, step, refresh, aggMode, profile = 'live', bypassCache = false, skipCircuit = false } = spec
  const timeouts = PROFILE_TIMEOUTS[profile] || PROFILE_TIMEOUTS.live

  if (bypassCache) {
    if (!skipCircuit && circuit.openUntil > Date.now()) {
      throw new UpstreamError('circuit_open')
    }
    try {
      const data = await fetchFromUpstream(env, queryType, { expr, time, start, end, step }, timeouts)
      if (!skipCircuit) circuit.consecutiveFailures = 0
      return {
        data,
        meta: { hit: false, age_seconds: 0, ttl_seconds: PROM_CACHE_TTL_SECONDS, stale: false, fetched_at: new Date().toISOString(), refresh_throttled: false }
      }
    } catch (err) {
      // m-7 수정(리뷰 2026-09-03): not_configured는 네트워크를 타지도 않는 정적 설정 오류라 상류의
      // 건강 상태와 무관하다 — 회로차단 카운터에 넣지 않는다(아래 non-bypass 경로와 동일 규칙).
      // 결정2 — insecure_scheme/invalid_upstream_url도 같은 이유로 제외(STATIC_CONFIG_ERROR_REASONS).
      if (!skipCircuit && !(err instanceof UpstreamError && STATIC_CONFIG_ERROR_REASONS.has(err.reason))) {
        circuit.consecutiveFailures += 1
        if (circuit.consecutiveFailures >= PROM_CIRCUIT_FAILURE_THRESHOLD) {
          circuit.openUntil = Date.now() + PROM_CIRCUIT_OPEN_MS
        }
      }
      console.error('[prom-client] cron upstream fetch failed', err instanceof UpstreamError ? err.reason : 'unknown', err && err.message)
      throw err
    }
  }

  const key = await buildCacheKey({ aggMode, queryType, expr, time, start, end, step })
  const now = Date.now()

  let forceRefresh = false
  let refreshThrottled = false
  if (refresh) {
    if (now - lastForcedFetchAt < PROM_REFRESH_THROTTLE_MS) {
      refreshThrottled = true // 연타 방지(§7.6) — refresh 요청이지만 캐시를 그대로 쓴다.
    } else {
      forceRefresh = true
      lastForcedFetchAt = now
    }
  }

  if (!forceRefresh) {
    const l1 = l1Get(key)
    if (l1 && now - l1.fetchedAt < PROM_CACHE_TTL_SECONDS * 1000) {
      return freshResult(l1, now, { fromCache: true, refreshThrottled })
    }
  }

  if (circuit.openUntil > now) {
    return fallbackOrThrow(key, now, 'circuit_open')
  }

  if (inFlight.has(key)) {
    try {
      const entry = await inFlight.get(key)
      return freshResult(entry, Date.now(), { fromCache: false, refreshThrottled })
    } catch (err) {
      return fallbackOrThrow(key, Date.now(), err instanceof UpstreamError ? err.reason : 'upstream_error')
    }
  }

  const fetchPromise = fetchFromUpstream(env, queryType, { expr, time, start, end, step }, timeouts)
    .then(async (data) => {
      circuit.consecutiveFailures = 0
      const entry = { data, fetchedAt: Date.now() }
      l1Set(key, entry)
      await l2Set(key, entry)
      return entry
    })
    .catch((err) => {
      // m-7 수정 — 신규 배포 직후 등 설정이 아예 없는 상태(not_configured)를 회로차단 실패로
      // 세면, 몇 번 뒤 회로가 열려 이후 모든 응답의 reason이 'circuit_open'으로 덮여쓰여 "설정이
      // 없다"는 진짜 원인이 사라진다(운영자 오진단 유발). not_configured는 재시도로 해결되지 않는
      // 정적 오류이므로 회로차단 집계에서 제외한다(결정2 — insecure_scheme/invalid_upstream_url도 동일).
      if (!(err instanceof UpstreamError && STATIC_CONFIG_ERROR_REASONS.has(err.reason))) {
        circuit.consecutiveFailures += 1
        if (circuit.consecutiveFailures >= PROM_CIRCUIT_FAILURE_THRESHOLD) {
          circuit.openUntil = Date.now() + PROM_CIRCUIT_OPEN_MS
        }
      }
      console.error('[prom-client] upstream fetch failed', err instanceof UpstreamError ? err.reason : 'unknown', err && err.message)
      throw err
    })
    .finally(() => inFlight.delete(key))

  inFlight.set(key, fetchPromise)

  try {
    const entry = await fetchPromise
    return freshResult(entry, Date.now(), { fromCache: false, refreshThrottled })
  } catch (err) {
    return fallbackOrThrow(key, Date.now(), err instanceof UpstreamError ? err.reason : 'upstream_error')
  }
}

/** 동시 아웃바운드는 웨이브당 최대 3개(Workers 6연결 한도, 설계 §4.4). 순서를 보존해 반환한다. */
export async function runQueriesInWaves(env, specs) {
  const results = new Array(specs.length)
  for (let i = 0; i < specs.length; i += PROM_MAX_WAVE_SIZE) {
    const wave = specs.slice(i, i + PROM_MAX_WAVE_SIZE)
    const waveResults = await Promise.all(wave.map((spec) => queryProm(env, spec)))
    waveResults.forEach((r, idx) => { results[i + idx] = r })
  }
  return results
}

/** 라우트 전체 예산(§9.1) — 초과 시 UpstreamError('timeout')로 즉시 폴백 경로를 타게 한다. */
export async function withRouteBudget(promise) {
  let timer
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamError('timeout', 'route budget exceeded')), PROM_ROUTE_BUDGET_MS)
  })
  try {
    return await Promise.race([promise, budget])
  } finally {
    clearTimeout(timer)
  }
}
