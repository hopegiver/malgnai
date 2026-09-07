// PromQL 정본 + 응답 정규화 — HTTP를 모른다(설계 §3 모듈 경계 원칙). 전송·캐시·재시도는
// server/lib/prom-client.js가 맡는다. D1 롤업 캐시 접근은 server/dao/usage-prom-daily.js가 맡는다.
// docs/design/usage-prometheus-realtime.md rev.2가 이 파일의 구현 정본(특히 §17.5·§19·§20),
// docs/design/usage-employee-identity.md가 식별 축(employee_id) 개정분의 정본이다.
import { runQueriesInWaves, withRouteBudget, PROM_CACHE_TTL_SECONDS } from './prom-client.js'
import { readHybridSnapshot } from '../dao/usage-prom-daily.js'
import { todayUTCString as sharedTodayUTCString, addDaysUTC } from './utc-day.js'
import { employeeIdMatcher, isPromSafeEmployeeId, decodeEmployeeName, resolveEmployeeScope, pickDisplayName } from './usage-identity.js'

// 집계식 정본 — 이 상수 하나에서만 모든 PromQL이 생성된다(설계 G3 "안전 임계값 정본 단일화").
// increase(): Prometheus 관용구, 회사 Grafana와 동일 계산(전환 목적에 부합). 세션 첫 샘플 과소집계는
// 감내(G3 캘리브레이션 결과 채택값). 바꾸려면 이 상수만 고치면 된다 — 다른 파일에 식을 복사하지 말 것.
export const AGG_MODE = 'increase'

// 값 정규화 로직 버전(설계 §4.6·§17.3) — 정규화 규칙(반올림·클램프·필드 매핑 등)이 바뀌면 올린다.
// usage_prom_sync_days.norm_version과 비교해 옛 규칙으로 적재된 날짜를 재적재 대상으로 간주한다.
export const NORM_VERSION = 'v1'

// 식별·표시 속성 버전(usage-employee-identity.md §9.1 신규) — employee_id 축·employee_name 디코드
// 등 "누구의 값인가"를 관장한다. 측정값 자체(NORM_VERSION)와 분리한 이유: NORM_VERSION을 올리면
// readHybridSnapshot()의 JOIN 조건(agg_mode+norm_version 일치)에서 레거시 캐시 전 구간이 즉시
// 빠져 gap_days가 되지만, 레거시 행의 측정값은 전혀 틀리지 않았다(§9.1). 그래서 읽기 판정
// (coveredDays/computeCachedThrough)은 AGG_MODE+NORM_VERSION만 보고, 적재 대상 판정
// (usage-rollup.js isValidMarker)만 IDENTITY_VERSION까지 본다 — 과거 날짜는 미식별 행으로 계속
// 보이면서 지평(ROLLUP_HORIZON_DAYS) 안에서 자동 재적재된다.
export const IDENTITY_VERSION = 'v1'

// 라이브 창의 완결일 상한(설계 §19.2) — 오늘 부분일 + 최대 이 일수만큼의 트레일링 완결일까지만
// 상류에 묻는다. 이보다 오래된 결손은 gap_days로 보고하고 다음 Cron이 치유한다(§20.2).
const LIVE_MAX_COMPLETE_DAYS = 2

export const UNAVAILABLE_FIELDS = ['tool_calls', 'tool_errors', 'retries', 'turns', 'api_calls']

const DAY_MS = 86400000

const METRICS = {
  tokens: 'claude_code_token_usage_tokens_total',
  sessions: 'claude_code_session_count_total',
  cost: 'claude_code_cost_usage_USD_total',
  activeTime: 'claude_code_active_time_seconds_total'
}

const TYPE_FIELD_MAP = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheRead: 'cache_read_tokens',
  cacheCreation: 'cache_write_tokens'
}

// ---------------------------------------------------------------------------
// PromQL 인젝션 방지(설계 §4.7, usage-employee-identity.md §4.4) — from/to는 쿼리 파라미터로만
// 들어가고(이 파일에서 문자열 조립 안 함), D1에서 온 email/employee_id만 검증+이스케이프 후 라벨
// 매처에 삽입한다. 요청 값(sort/order/limit)은 이 표현식 조립에 절대 관여하지 않는다.
//
// employee_id 축(1차 키) 검증·매처 조립은 usage-identity.js(employeeIdMatcher/resolveEmployeeScope)
// 로 옮겨졌다 — 이 파일은 그 함수들을 그대로 가져다 쓴다. user_email(그룹 계정, 메타데이터 축)의
// 이메일 형식 검증은 이 파일에 그대로 남는다(관리자 목록 조립에서 D1 이메일 자체를 매처에 넣는
// 경로는 없어졌지만, isPromSafeEmail은 하위 호환을 위해 남겨둔다 — 더 이상 라벨 매처 조립에는
// 쓰이지 않는다).
// ---------------------------------------------------------------------------
const EMAIL_LABEL_RE = /^[^\s"\\{}]+@[^\s"\\{}]+$/

export function isPromSafeEmail(email) {
  return typeof email === 'string' && EMAIL_LABEL_RE.test(email)
}

function metricSelector(metric, matchers = []) {
  return matchers.length ? `${metric}{${matchers.join(',')}}` : metric
}

function agg(metricExpr, duration) {
  return `${AGG_MODE}(${metricExpr}[${duration}])`
}

// §4.1 표 — by 절 선두에 employee_id가 추가됐고, user_email은 그룹 계정 메타로 그대로 남는다
// (빼면 "이 계정을 누가 쓰는가"에 답할 수 없다, PM 제약). 드릴다운/본인 스코프의 라벨 매처는
// user_email="…" → employee_id="…"로 교체됐다(호출부가 넘기는 matchers 배열의 내용이 바뀔 뿐,
// 이 함수들 자체는 matchers를 그대로 삽입하기만 한다).
function exprTokensByUser(duration, matchers = []) {
  return `sum by(employee_id, user_email, employee_name, type) (${agg(metricSelector(METRICS.tokens, matchers), duration)})`
}
function exprSessionsByUser(duration, matchers = []) {
  return `sum by(employee_id, user_email, employee_name) (${agg(metricSelector(METRICS.sessions, matchers), duration)})`
}
function exprCostByUser(duration, matchers = []) {
  return `sum by(employee_id, user_email, employee_name) (${agg(metricSelector(METRICS.cost, matchers), duration)})`
}
function exprTokensByModel(duration, matchers) {
  return `sum by(model, type) (${agg(metricSelector(METRICS.tokens, matchers), duration)})`
}
function exprCostByModel(duration, matchers) {
  return `sum by(model) (${agg(metricSelector(METRICS.cost, matchers), duration)})`
}
function exprActiveTime(duration, matchers) {
  return `sum by(employee_id) (${agg(metricSelector(METRICS.activeTime, matchers), duration)})`
}

// ---------------------------------------------------------------------------
// 시간창 계산 — 일별 그리드 off-by-one(설계 §4.2), 오늘 부분일(§4.3), 기간 합계 instant(§4.4 2웨이브)
// ⚠️ rev.2: 아래 함수들은 라이브 경로와 Cron 적재 경로(fetchCompletedDayGrid)가 그대로 공유한다
// (설계 §19.3-4, §21.1 "유지" 목록) — usage-rollup.js에 유사 계산을 새로 쓰지 말 것.
//
// m-1 수정(리뷰 2026-09-03): 이 아래 함수들은 모두 "지금"을 나타내는 nowMs를 인자로 받는다(기본값
// Date.now() — 단독 호출/테스트 편의용일 뿐, 한 요청 처리 도중에는 절대 기본값에 기대지 말 것).
// 이전에는 각 함수가 각자 `new Date()`/`Date.now()`를 다시 불러 한 요청 안에서 UTC 자정을 걸치면
// (드물지만) "오늘"의 값이 함수마다 갈릴 수 있었다(예: 그리드는 아직 어제를 오늘로 보는데 부분일
// 질의는 이미 다음날로 넘어감). 호출부(getUsageOverview/fetchCompletedDayGrid/getUsageOverviewHybrid/
// getUserDrilldown)가 각자 진입 시점에 nowMs를 한 번만 고정해 하위 함수 전체에 그대로 넘긴다 —
// 실패 모드 자체는 이중계상이 아니라 "오늘이 정직하게 gap_days로 빠지는 것"이라 심각도는 낮았지만
// (원인 자체를 없앤다).
// ---------------------------------------------------------------------------
function todayStartUTCms(nowMs = Date.now()) {
  const now = new Date(nowMs)
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

// m-2 — todayUTCString/addDaysUTC는 이제 이 파일에서 재정의하지 않고 server/lib/utc-day.js(정본)를
// 그대로 쓴다. 로컬 이름을 유지해 아래 호출부를 그대로 두었다(재사용은 import 한 줄로 충분).
const todayUTCString = sharedTodayUTCString

function allDaysInRange(from, to) {
  const days = []
  for (let d = from; d <= to; d = addDaysUTC(d, 1)) days.push(d)
  return days
}

/** query_range 평가시각 t는 t-1일의 값이므로(§4.2) 그리드 시작/끝을 하루 밀어 요청한다.
 *  end는 "오늘 00:00Z"를 넘지 않게 클램프 — 오늘분은 별도 instant 질의(§4.3)로 얹는다.
 *  완결된 날짜 버킷이 없으면(예: from=to=오늘) null. */
export function dayGridWindow(from, to, nowMs = Date.now()) {
  const todayMs = todayStartUTCms(nowMs)
  const startMs = Date.parse(`${from}T00:00:00Z`) + DAY_MS
  const rawEndMs = Date.parse(`${to}T00:00:00Z`) + DAY_MS
  const endMs = Math.min(rawEndMs, todayMs)
  if (startMs > endMs) return null
  return { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000), step: 86400 }
}

// M-2 수정(리뷰 2026-09-03): "지금"을 초 단위 그대로 쓰면 time/rangeSeconds가 매초 바뀌어
// buildCacheKey(prom-client.js)의 캐시 키가 매 요청마다 달라진다 — L1/L2 캐시 60초 TTL·요청 병합
// (coalescing)·stale 폴백이 전부 무효화된다(정상 상태에서도 캐시 히트가 사실상 0이 된다). "지금"을
// TTL 버킷(PROM_CACHE_TTL_SECONDS=60초, prom-client.js 정본) 크기로 내림해 같은 버킷 안의 모든 요청이
// 같은 키를 쓰게 한다. 버킷 크기가 TTL과 같으므로 정확도 손실은 없다 — 캐시가 정상 작동했어도 응답은
// 최대 TTL만큼 낡을 수 있었으니, 버킷팅은 "이미 약속한 정확도"를 실제로 구현하는 것뿐이다(리뷰
// 트레이드오프 3 "정확도를 낮추는 게 아니라 이미 약속한 정확도를 실제로 구현하는 것"). 버킷 크기를
// TTL과 다르게 하려면(예: 캐시는 60초인데 버킷은 30초) 이 주석과 함께 반드시 같이 바꿀 것 — 버킷이
// TTL보다 크면 캐시가 실제보다 더 오래된 값을 계속 돌려주고, TTL보다 작으면 이 함수의 존재 의미가
// 없어진다.
function nowBucketSeconds(nowMs = Date.now()) {
  const bucketMs = PROM_CACHE_TTL_SECONDS * 1000
  return Math.floor(nowMs / bucketMs) * PROM_CACHE_TTL_SECONDS
}

/** to가 오늘보다 과거면 오늘분 질의 자체를 생략(질의 예산 절약, §4.3). */
export function todayPartialWindow(to, nowMs = Date.now()) {
  const todayStr = todayUTCString(nowMs)
  if (to < todayStr) return null
  const startSec = Math.floor(todayStartUTCms(nowMs) / 1000)
  const bucketSec = nowBucketSeconds(nowMs)
  const rangeSeconds = Math.max(1, bucketSec - startSec)
  return { time: bucketSec, rangeSeconds }
}

/** by_model/active_time 등 "일별 아닌 기간 합계" instant 질의용 — from 00:00Z부터 min(to+1일, now)까지.
 *  "now"가 상한으로 걸리는 경우(to가 오늘 이후로 클램프될 때)만 TTL 버킷으로 내림한다 — to가 과거
 *  구간이면 endMs는 이미 날짜 경계로 고정돼 있어 버킷팅이 필요도, 영향도 없다. */
function periodTotalWindow(from, to, nowMs = Date.now()) {
  const startMs = Date.parse(`${from}T00:00:00Z`)
  const rawEndMs = Date.parse(`${to}T00:00:00Z`) + DAY_MS
  const bucketMs = nowBucketSeconds(nowMs) * 1000
  const endMs = Math.min(rawEndMs, bucketMs)
  const rangeSeconds = Math.max(1, Math.floor((endMs - startMs) / 1000))
  return { time: Math.floor(endMs / 1000), rangeSeconds }
}

// ---------------------------------------------------------------------------
// 값 정규화(설계 §4.6)
// ---------------------------------------------------------------------------
export function roundNonNegative(strVal) {
  const n = Number(strVal)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.round(n))
}

export function truncateCost(strVal) {
  const n = Number(strVal)
  if (!Number.isFinite(n)) return 0
  return Math.floor(Math.max(0, n) * 10000) / 10000
}

/** increase()는 t-1일의 값이므로 응답 타임스탬프를 하루 되돌려 day_at으로 매핑(§4.2). */
export function promTimestampToDayAt(tSeconds) {
  return new Date(tSeconds * 1000 - DAY_MS).toISOString().slice(0, 10)
}

function pointsOf(series) {
  if (series.values) return series.values
  if (series.value) return [series.value]
  return []
}

// ---------------------------------------------------------------------------
// 사용자 엔트리 키 구조(usage-employee-identity.md §5.1) — 병합은 "관측 단위 그대로"(unit:
// employee_id×user_email 쌍), 응답 조립 직전에만 foldToEmployees()로 직원 단위로 접는다. 두 단계로
// 나누는 이유: group_accounts(그룹 계정별 사용량)를 캐시 구간에서도 재현하려면 (직원 × 계정 × 날짜)
// 그레인이 필요하기 때문이다(§5.1).
//
// unitKey 구분자는 US(0x1F, PromQL 라벨 값에도 employee_id 허용목록에도 나타날 수 없는 문자) —
// 'a'+'b@x'와 'ab'+'@x' 같은 키 충돌이 원천적으로 불가능하다(§5.1).
// ---------------------------------------------------------------------------
const UNIT_KEY_SEP = ''

export function unitKeyOf(employeeId, userEmail) {
  return `${employeeId || ''}${UNIT_KEY_SEP}${userEmail || ''}`
}

/** PromQL 라벨(원본 대소문자)에서 unit 식별자를 뽑아 항상 소문자로 정규화한다 — employee_id는
 *  §3.2 규칙(D1 로컬파트와 비교되므로), user_email은 기존 §17.3 저장 규칙(소문자 정규화)을 그대로
 *  따른다. 둘 다 없으면(N2 "unk:" 버킷) null/null로 unitKey는 빈 구분자만 남는다. */
function unitIdentityFromLabels(labels) {
  const employeeId = typeof labels.employee_id === 'string' && labels.employee_id ? labels.employee_id.toLowerCase() : null
  const userEmail = typeof labels.user_email === 'string' && labels.user_email ? labels.user_email.toLowerCase() : null
  return { employeeId, userEmail }
}

/** byUnit Map에 라벨 기준 엔트리를 확보/갱신한다. employee_id 라벨이 없는 관측치(그룹 계정만 관측)
 *  도, 둘 다 없는 관측치(§5.2 unknown)도 버리지 않고 그대로 담는다(§5.2 폴백 표 — "버리지 않는다"가
 *  이 함수가 절대 emailLower 없다고 continue하지 않는 이유다). */
function ensureUnitEntry(byUnit, labels) {
  const { employeeId, userEmail } = unitIdentityFromLabels(labels)
  const unitKey = unitKeyOf(employeeId, userEmail)
  let entry = byUnit.get(unitKey)
  if (!entry) {
    entry = { employeeId, userEmail, employeeNames: new Set(), days: new Map() }
    byUnit.set(unitKey, entry)
  }
  // employee_name은 URL 인코딩된 한글이라(§1.1) 표시 직전 디코드한다(§4.3 값 정규화 6항). 여러 값이
  // 관측되면(N4) 전부 Set에 모으고, 표시 시점에 pickDisplayName(사전순 최소)이 하나를 고른다.
  if (labels.employee_name) entry.employeeNames.add(decodeEmployeeName(labels.employee_name))
  return entry
}

function ensureDayEntry(entry, dayAt) {
  let day = entry.days.get(dayAt)
  if (!day) {
    day = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, session_count: 0, cost_usd: 0 }
    entry.days.set(dayAt, day)
  }
  return day
}

function mergeTokens(byUnit, unknownTypes, result, isInstant, instantDayAt) {
  for (const series of result || []) {
    const labels = series.metric || {}
    const field = TYPE_FIELD_MAP[labels.type]
    if (!field) {
      if (labels.type) unknownTypes.add(labels.type) // 새 토큰 종류를 조용히 버리지 않는다(§4.6-5)
      continue
    }
    const entry = ensureUnitEntry(byUnit, labels)
    for (const [t, v] of pointsOf(series)) {
      const dayAt = isInstant ? instantDayAt : promTimestampToDayAt(t)
      const day = ensureDayEntry(entry, dayAt)
      day[field] += roundNonNegative(v)
    }
  }
}

function mergeSingleField(byUnit, result, field, transform, isInstant, instantDayAt) {
  for (const series of result || []) {
    const labels = series.metric || {}
    const entry = ensureUnitEntry(byUnit, labels)
    for (const [t, v] of pointsOf(series)) {
      const dayAt = isInstant ? instantDayAt : promTimestampToDayAt(t)
      const day = ensureDayEntry(entry, dayAt)
      day[field] += transform(v)
    }
  }
}

// spec 플래그(설계 §9.1) — profile:'cron'이면 bypassCache/skipCircuit을 함께 태운다(prom-client.js
// 격리 규칙). 호출부(runOverviewSpecsAndMerge)가 이 헬퍼 하나로만 spec을 만든다.
function profileFlags(profile) {
  return profile === 'cron' ? { profile: 'cron', bypassCache: true, skipCircuit: true } : { profile: 'live' }
}

function tokensGridSpec(grid, refresh, matchers, profile) {
  return { aggMode: AGG_MODE, queryType: 'query_range', expr: exprTokensByUser('1d', matchers), start: grid.start, end: grid.end, step: grid.step, refresh, ...profileFlags(profile) }
}
function sessionsGridSpec(grid, refresh, matchers, profile) {
  return { aggMode: AGG_MODE, queryType: 'query_range', expr: exprSessionsByUser('1d', matchers), start: grid.start, end: grid.end, step: grid.step, refresh, ...profileFlags(profile) }
}
function costGridSpec(grid, refresh, matchers, profile) {
  return { aggMode: AGG_MODE, queryType: 'query_range', expr: exprCostByUser('1d', matchers), start: grid.start, end: grid.end, step: grid.step, refresh, ...profileFlags(profile) }
}
function tokensTodaySpec(today, refresh, matchers, profile) {
  return { aggMode: AGG_MODE, queryType: 'query', expr: exprTokensByUser(`${today.rangeSeconds}s`, matchers), time: today.time, refresh, ...profileFlags(profile) }
}
function sessionsTodaySpec(today, refresh, matchers, profile) {
  return { aggMode: AGG_MODE, queryType: 'query', expr: exprSessionsByUser(`${today.rangeSeconds}s`, matchers), time: today.time, refresh, ...profileFlags(profile) }
}
function costTodaySpec(today, refresh, matchers, profile) {
  return { aggMode: AGG_MODE, queryType: 'query', expr: exprCostByUser(`${today.rangeSeconds}s`, matchers), time: today.time, refresh, ...profileFlags(profile) }
}

export function aggregateCacheMeta(results) {
  if (!results.length) {
    return { hit: true, age_seconds: 0, ttl_seconds: 60, stale: false, fetched_at: new Date().toISOString(), refresh_throttled: false }
  }
  let hit = true
  let stale = false
  let refreshThrottled = false
  let maxFetchedAtMs = 0
  let maxAge = 0
  for (const r of results) {
    if (!r.meta.hit) hit = false
    if (r.meta.stale) stale = true
    if (r.meta.refresh_throttled) refreshThrottled = true
    const ms = Date.parse(r.meta.fetched_at)
    if (ms > maxFetchedAtMs) maxFetchedAtMs = ms
    if (r.meta.age_seconds > maxAge) maxAge = r.meta.age_seconds
  }
  return { hit, age_seconds: maxAge, ttl_seconds: results[0].meta.ttl_seconds, stale, fetched_at: new Date(maxFetchedAtMs).toISOString(), refresh_throttled: refreshThrottled }
}

/** grid/today 스펙 실행 + byUnit/unknownTypes에 직접 병합. 스펙이 없으면(날짜창이 비어 있으면)
 *  상류를 부르지 않고 빈 배열을 반환한다. profile='cron'이면 Cron 적재 격리 규칙(bypassCache/
 *  skipCircuit)이 적용된 스펙을 만든다(§9.1) — 표현식·그리드 계산은 라이브와 완전히 동일 함수를 쓴다
 *  (§19.3-4 이음매 불변식). */
async function runOverviewSpecsAndMerge(env, { grid, today, refresh, matchers, byUnit, unknownTypes, profile = 'live', nowMs = Date.now() }) {
  const specs = []
  const idx = {}
  if (grid) {
    idx.tokensGrid = specs.push(tokensGridSpec(grid, refresh, matchers, profile)) - 1
    idx.sessionsGrid = specs.push(sessionsGridSpec(grid, refresh, matchers, profile)) - 1
    idx.costGrid = specs.push(costGridSpec(grid, refresh, matchers, profile)) - 1
  }
  if (today) {
    idx.tokensToday = specs.push(tokensTodaySpec(today, refresh, matchers, profile)) - 1
    idx.sessionsToday = specs.push(sessionsTodaySpec(today, refresh, matchers, profile)) - 1
    idx.costToday = specs.push(costTodaySpec(today, refresh, matchers, profile)) - 1
  }
  if (!specs.length) return []

  const results = await runQueriesInWaves(env, specs)
  // m-1 — 이 today 버킷의 day_at은 반드시 "이 grid/today 창을 계산할 때 쓴 그 nowMs" 기준이어야
  // 한다. 호출부(runOverviewSpecsAndMerge를 호출하기 전 todayPartialWindow(to, nowMs)를 만든 바로 그
  // nowMs)와 항상 같은 값을 넘겨받는다 — 여기서 다시 Date.now()를 부르지 않는다.
  const todayDayAt = todayUTCString(nowMs)

  if (grid) {
    mergeTokens(byUnit, unknownTypes, results[idx.tokensGrid].data, false)
    mergeSingleField(byUnit, results[idx.sessionsGrid].data, 'session_count', roundNonNegative, false)
    mergeSingleField(byUnit, results[idx.costGrid].data, 'cost_usd', truncateCost, false)
  }
  if (today) {
    mergeTokens(byUnit, unknownTypes, results[idx.tokensToday].data, true, todayDayAt)
    mergeSingleField(byUnit, results[idx.sessionsToday].data, 'session_count', roundNonNegative, true, todayDayAt)
    mergeSingleField(byUnit, results[idx.costToday].data, 'cost_usd', truncateCost, true, todayDayAt)
  }
  return results
}

/** /summary, /users, /users/:id 공용 — unit(employee_id×user_email)×일 그리드를 Prometheus에서
 *  가져와 병합한다(전 구간 라이브 경로. 전사 요약 하이브리드는 아래 getUsageOverviewHybrid를 쓴다,
 *  rev.2 §0.1 C1·C9). matchers를 주면 특정 employee_id로 서버측 필터링(드릴다운). matchers가 비어
 *  있으면(전사 무필터) rev.2 기준 라이브 창은 최대 3일이라(§19.2) 팬아웃 없이 그대로 질의한다
 *  (rev.1 팬아웃은 폐기, §21.1). */
export async function getUsageOverview(env, { from, to, refresh, matchers = [] } = {}) {
  const nowMs = Date.now() // m-1 — 이 호출 전체에서 "지금"을 한 번만 고정
  const grid = dayGridWindow(from, to, nowMs)
  const today = todayPartialWindow(to, nowMs)
  const byUnit = new Map()
  const unknownTypes = new Set()
  const results = await runOverviewSpecsAndMerge(env, { grid, today, refresh, matchers, byUnit, unknownTypes, nowMs })
  return { byUnit, unknownTypes, meta: aggregateCacheMeta(results), rawResults: results }
}

/** Cron 적재 전용(설계 §18.4) — 완결일 그리드만 질의(오늘 부분일 없음), profile='cron'으로
 *  prom-client의 적재 격리 플래그를 태운다. dayGridWindow/표현식 빌더를 라이브와 그대로 공유해
 *  이음매 양쪽이 항상 같은 계산을 하도록 보장한다(§19.3-4, §21.1). */
export async function fetchCompletedDayGrid(env, { from, to, matchers = [] } = {}) {
  const nowMs = Date.now()
  const grid = dayGridWindow(from, to, nowMs)
  const byUnit = new Map()
  const unknownTypes = new Set()
  if (!grid) return { byUnit, unknownTypes }
  await runOverviewSpecsAndMerge(env, { grid, today: null, refresh: false, matchers, byUnit, unknownTypes, profile: 'cron', nowMs })
  return { byUnit, unknownTypes }
}

export function zeroTotals() {
  return { session_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost_usd: 0, active_days: 0, last_active_day: null }
}

export function userDayRows(entry) {
  return Array.from(entry.days.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dayAt, v]) => ({
      day_at: dayAt,
      session_count: v.session_count,
      input_tokens: v.input_tokens,
      output_tokens: v.output_tokens,
      cache_read_tokens: v.cache_read_tokens,
      cache_write_tokens: v.cache_write_tokens,
      total_tokens: v.input_tokens + v.output_tokens + v.cache_read_tokens + v.cache_write_tokens,
      cost_usd: Math.round(v.cost_usd * 10000) / 10000
    }))
}

export function userTotals(entry) {
  const days = userDayRows(entry)
  const totals = days.reduce((acc, d) => {
    acc.session_count += d.session_count
    acc.input_tokens += d.input_tokens
    acc.output_tokens += d.output_tokens
    acc.cache_read_tokens += d.cache_read_tokens
    acc.cache_write_tokens += d.cache_write_tokens
    acc.cost_usd += d.cost_usd
    return acc
  }, zeroTotals())
  totals.total_tokens = totals.input_tokens + totals.output_tokens + totals.cache_read_tokens + totals.cache_write_tokens
  totals.cost_usd = Math.round(totals.cost_usd * 10000) / 10000
  const activeDays = days.filter((d) => d.total_tokens > 0)
  totals.active_days = activeDays.length
  totals.last_active_day = activeDays.length ? activeDays[activeDays.length - 1].day_at : null
  return totals
}

/** 전사 일별 추세(/summary) — unit(직원×계정) 축을 합산해 day_at별 합계로 접는다(설계 §5.2,
 *  /users와 같은 Map 결과를 축만 바꿔 접음 → KPI·표 정합이 구조적으로 보장됨. rev.2 §19.4). §5.1의
 *  foldToEmployees는 쓰지 않는다 — 직원 축을 어차피 합산하므로 byUnit을 그대로 훑어도 결과가 같다
 *  (usage-employee-identity.md §7.2). */
export function daySummaryRows(byUnit) {
  const byDay = new Map()
  for (const entry of byUnit.values()) {
    for (const [dayAt, v] of entry.days) {
      let d = byDay.get(dayAt)
      if (!d) {
        d = { day_at: dayAt, session_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 }
        byDay.set(dayAt, d)
      }
      d.session_count += v.session_count
      d.input_tokens += v.input_tokens
      d.output_tokens += v.output_tokens
      d.cache_read_tokens += v.cache_read_tokens
      d.cache_write_tokens += v.cache_write_tokens
      d.cost_usd += v.cost_usd
    }
  }
  return Array.from(byDay.values())
    .sort((a, b) => (a.day_at < b.day_at ? -1 : a.day_at > b.day_at ? 1 : 0))
    .map((d) => ({
      ...d,
      total_tokens: d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_tokens,
      cost_usd: Math.round(d.cost_usd * 10000) / 10000,
      tool_calls: null, tool_errors: null, retries: null, turns: null, api_calls: null
    }))
}

// ---------------------------------------------------------------------------
// 2단계 접기(usage-employee-identity.md §5.1) — byUnit(employeeId×userEmail 그레인)을 응답 조립
// 직전에 직원 단위(rowKey)로 접는다. /me·/users·/users/:id 세 곳이 공용으로 쓴다(/summary는 위
// daySummaryRows가 byUnit을 그대로 쓰므로 이 함수를 거치지 않는다).
// ---------------------------------------------------------------------------
function emptyAccountTotals() {
  return { session_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 }
}

function addValuesInto(acc, v) {
  acc.session_count += v.session_count
  acc.input_tokens += v.input_tokens
  acc.output_tokens += v.output_tokens
  acc.cache_read_tokens += v.cache_read_tokens
  acc.cache_write_tokens += v.cache_write_tokens
  acc.cost_usd += v.cost_usd
}

/** rowKey 규칙(§5.1): employee_id 있으면 emp:<id>, 없고 user_email만 있으면 grp:<email>, 둘 다
 *  없으면 unk:(최대 1행) — 응답 내 유일 키이자 tie-break 키(row_key)의 정본이다. */
export function rowKeyOf(employeeId, userEmail) {
  if (employeeId) return `emp:${employeeId}`
  if (userEmail) return `grp:${userEmail}`
  return 'unk:'
}

/** byUnit → Map<rowKey, EmployeeEntry>. EmployeeEntry.days는 계정을 합산해 직원×날짜로 접은 것 —
 *  기존 userDayRows()/userTotals()가 손대지 않고 그대로 동작한다(둘 다 entry.days만 본다).
 *  EmployeeEntry.accounts는 계정별 기간 합계만 갖는다(group_accounts 응답에 필요한 전부). */
export function foldToEmployees(byUnit) {
  const employees = new Map()
  for (const unit of byUnit.values()) {
    const rowKey = rowKeyOf(unit.employeeId, unit.userEmail)
    let emp = employees.get(rowKey)
    if (!emp) {
      emp = {
        rowKey,
        employeeId: unit.employeeId || null,
        identitySource: unit.employeeId ? 'employee_id' : (unit.userEmail ? 'group_account' : 'unknown'),
        employeeNames: new Set(),
        accounts: new Map(),
        days: new Map()
      }
      employees.set(rowKey, emp)
    }
    for (const n of unit.employeeNames) emp.employeeNames.add(n)

    for (const [dayAt, v] of unit.days) {
      const day = ensureDayEntry(emp, dayAt)
      addValuesInto(day, v)
    }

    const accountKey = unit.userEmail || ''
    let acct = emp.accounts.get(accountKey)
    if (!acct) {
      acct = emptyAccountTotals()
      emp.accounts.set(accountKey, acct)
    }
    for (const v of unit.days.values()) addValuesInto(acct, v)
  }
  return employees
}

/** EmployeeEntry.accounts → group_accounts 응답 배열(§6.3·§7.1): [{ user_email, total_tokens,
 *  cost_usd, session_count }], total_tokens 내림차순. accountKey가 ''(userEmail 라벨 자체가 없던
 *  unit, unk: 행)은 응답에 실을 계정이 없으므로 제외한다. */
export function groupAccountsOf(emp) {
  return Array.from(emp.accounts.entries())
    .filter(([userEmail]) => userEmail)
    .map(([userEmail, v]) => ({
      user_email: userEmail,
      total_tokens: v.input_tokens + v.output_tokens + v.cache_read_tokens + v.cache_write_tokens,
      cost_usd: Math.round(v.cost_usd * 10000) / 10000,
      session_count: v.session_count
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens)
}

/** D1 users × Prometheus 직원 병합(usage-employee-identity-linking.md §7.1 — 로컬파트 파생을
 *  대체). 병합 키는 이제 D1 users.employee_id 컬럼 그대로다(employeeIdFromEmail 호출 없음 — §3.2
 *  단방향 원칙: 컬럼이 정본이고 읽기 경로 폴백은 없다). 컬럼 도입으로 로컬파트 충돌 개념 자체가
 *  사라졌다(§3.3 폐기, 부분 UNIQUE 인덱스가 DB 수준에서 봉쇄) — 그 자리에 §4.4 S4 관측 이름 불일치
 *  경고(observed_employee_name/observed_name_mismatch)가 들어온다: 오연결(엉뚱한 사람에게 값을
 *  붙임)이 발생하면 그 행의 관측 이름이 D1 이름과 달라지므로 관리자가 즉시 알아챌 수 있다. D1
 *  사용자에 매칭되지 않는 관측치(허브 계정이 없거나 employee_id가 아직 아무에게도 연결되지 않은
 *  경우)는 employees Map에서 소비되지 않은 채 남아 아래 두 번째 루프에서 prometheus_only 행으로
 *  분리된다 — 값이 사라지지 않고 총합이 보존된다(§7.1). */
export function mergeD1AndPromUsers(d1Users, byUnit) {
  const employees = foldToEmployees(byUnit)
  const rows = []
  const consumedRowKeys = new Set()

  for (const u of d1Users) {
    const empId = u.employee_id || null
    const emp = empId ? employees.get(`emp:${empId}`) : null
    if (emp) consumedRowKeys.add(emp.rowKey)

    const totals = emp ? userTotals(emp) : zeroTotals()
    const groupAccounts = emp ? groupAccountsOf(emp) : []
    // observed_employee_name — 상류 employee_name 라벨(디코드됨, 사전순 최소). d1Name을 넘기지
    // 않아 "D1 이름과 별개로 관측된 이름 자체"만 얻는다(§7.2 — name과 별도 필드).
    const observedName = emp ? pickDisplayName({ d1Name: null, employeeNames: emp.employeeNames, employeeId: null }) : null
    const observedNameMismatch = !!(u.name && observedName && u.name !== observedName)
    const name = pickDisplayName({ d1Name: u.name, employeeNames: emp ? emp.employeeNames : null, employeeId: empId })

    rows.push({
      row_key: empId ? `emp:${empId}` : `d1only:${u.id}`,
      user_id: u.id,
      employee_id: empId,
      identity_source: empId ? 'employee_id' : null,
      name, email: u.email, role: u.role, status: u.status, source: 'd1_user',
      observed_employee_name: observedName,
      observed_name_mismatch: observedNameMismatch,
      group_accounts: groupAccounts,
      ...totals,
      tool_calls: null, tool_errors: null, retries: null, turns: null, api_calls: null
    })
  }
  for (const [rowKey, emp] of employees) {
    if (consumedRowKeys.has(rowKey)) continue
    const totals = userTotals(emp)
    const groupAccounts = groupAccountsOf(emp)
    const observedName = pickDisplayName({ d1Name: null, employeeNames: emp.employeeNames, employeeId: null })
    const name = pickDisplayName({ d1Name: null, employeeNames: emp.employeeNames, employeeId: emp.employeeId })
    rows.push({
      row_key: rowKey,
      user_id: null,
      employee_id: emp.employeeId,
      identity_source: emp.identitySource,
      name, email: null, role: null, status: 'unregistered', source: 'prometheus_only',
      observed_employee_name: observedName,
      observed_name_mismatch: false,
      group_accounts: groupAccounts,
      ...totals,
      tool_calls: null, tool_errors: null, retries: null, turns: null, api_calls: null
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// /users sort(설계 §5.1) — turns/api_calls/tool_errors는 400이 아니라 기본값 tokens로 폴백(구버전
// SPA가 열려 있는 채로 옛 파라미터를 보낼 수 있어 화면을 깨뜨리지 않는 쪽을 택함).
// ---------------------------------------------------------------------------
const SORT_FIELDS = { tokens: 'total_tokens', sessions: 'session_count', name: 'name', last_active: 'last_active_day', cost: 'cost_usd' }
const SORT_FALLBACK_ONLY = new Set(['turns', 'api_calls', 'tool_errors'])

export function resolveUsersSort(rawSort) {
  const sort = rawSort || 'tokens'
  if (Object.hasOwn(SORT_FIELDS, sort)) return { sort, field: SORT_FIELDS[sort], fellBack: false }
  if (SORT_FALLBACK_ONLY.has(sort)) return { sort: 'tokens', field: SORT_FIELDS.tokens, fellBack: true }
  return { sort: null, field: null, fellBack: false }
}

// tie-break 키가 email → row_key로 바뀐다(usage-employee-identity.md §7.1) — row_key는 응답 내
// 모든 행에 반드시 존재하는 유일 키(email은 이제 group_account/prometheus_only 행에서 null이다).
function tieBreak(a, b) {
  const ak = a.row_key || ''
  const bk = b.row_key || ''
  return ak < bk ? -1 : ak > bk ? 1 : 0
}

export function sortUserRows(rows, field, order) {
  const dir = order === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    let av = a[field]
    let bv = b[field]
    if (field === 'name') {
      av = (a.name || a.email || '').toLowerCase()
      bv = (b.name || b.email || '').toLowerCase()
    }
    if (av == null && bv == null) return tieBreak(a, b)
    if (av == null) return 1
    if (bv == null) return -1
    if (av < bv) return -1 * dir
    if (av > bv) return 1 * dir
    return tieBreak(a, b)
  })
}

// ---------------------------------------------------------------------------
// /users/:id 드릴다운 — by_model, active_time(설계 §5.3, §8)
// ---------------------------------------------------------------------------
function parseTokensByModelVector(vectorResult) {
  const byModel = new Map()
  const unknownTypes = new Set()
  for (const series of vectorResult || []) {
    const labels = series.metric || {}
    const model = labels.model || 'unknown'
    const field = TYPE_FIELD_MAP[labels.type]
    const points = pointsOf(series)
    const val = points.length ? points[points.length - 1][1] : '0'
    if (!field) {
      if (labels.type) unknownTypes.add(labels.type)
      continue
    }
    let entry = byModel.get(model)
    if (!entry) {
      entry = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
      byModel.set(model, entry)
    }
    entry[field] += roundNonNegative(val)
  }
  return { byModel, unknownTypes }
}

function parseCostByModelVector(vectorResult) {
  const byModel = new Map()
  for (const series of vectorResult || []) {
    const labels = series.metric || {}
    const model = labels.model || 'unknown'
    const points = pointsOf(series)
    const val = points.length ? points[points.length - 1][1] : '0'
    byModel.set(model, (byModel.get(model) || 0) + truncateCost(val))
  }
  return byModel
}

function parseSingleValueVector(vectorResult, { valueTransform }) {
  let total = 0
  for (const series of vectorResult || []) {
    const points = pointsOf(series)
    const val = points.length ? points[points.length - 1][1] : '0'
    total += valueTransform(val)
  }
  return total
}

function mergeModelMaps(tokensByModel, costByModel) {
  const models = new Set([...tokensByModel.keys(), ...costByModel.keys()])
  const rows = []
  for (const model of models) {
    const t = tokensByModel.get(model) || { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
    const cost = costByModel.get(model) || 0
    const total_tokens = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens
    rows.push({
      model,
      input_tokens: t.input_tokens, output_tokens: t.output_tokens,
      cache_read_tokens: t.cache_read_tokens, cache_write_tokens: t.cache_write_tokens,
      total_tokens, cost_usd: Math.round(cost * 10000) / 10000
    })
  }
  return rows.sort((a, b) => b.total_tokens - a.total_tokens)
}

/** GET /api/admin/usage/users/:id 전용 — employeeId가 PromQL 라벨매처로 안전하지 않거나
 *  Prometheus에 한 건도 없으면 notInMetrics=true, 200(빈 데이터)로 처리한다(§5.3 — 404가 아니다).
 *  usage-employee-identity-linking.md §4.6 — 매처 축은 D1 users.employee_id 컬럼 그대로다. 호출부
 *  (server/api/usage.js)가 target.employee_id를 그대로 넘긴다(§3.2 단방향 규칙 — 이 함수는
 *  employee_id로 사용자를 역조회하지 않는다, 그냥 매처에 넣을 뿐). */
export async function getUserDrilldown(env, { from, to, employeeId, refresh }) {
  if (!isPromSafeEmployeeId(employeeId)) {
    return { notInMetrics: true, rows: [], totals: { ...zeroTotals(), active_time_seconds: 0 }, groupAccounts: [], byModel: [], unknownTypes: new Set(), meta: aggregateCacheMeta([]) }
  }

  const matchers = [employeeIdMatcher(employeeId)]
  const overview = await getUsageOverview(env, { from, to, refresh, matchers })

  // m-1 — getUsageOverview 호출(첫 웨이브) 완료 후 다시 Date.now()를 부른다. by_model 등은 일별
  // day_at 그리드로 병합되지 않아(모델·비용 합계는 grain이 다름) todayDayAt 불일치 리스크는 없지만,
  // 캐시 버킷(§M-2)이 이 시점 기준으로 새로 정렬되는 것이 의도된 동작이다(두 웨이브 사이 실제
  // 상류 왕복 시간이 흘렀으므로).
  const period = periodTotalWindow(from, to, Date.now())
  const specs2 = [
    { aggMode: AGG_MODE, queryType: 'query', expr: exprTokensByModel(`${period.rangeSeconds}s`, matchers), time: period.time, refresh },
    { aggMode: AGG_MODE, queryType: 'query', expr: exprCostByModel(`${period.rangeSeconds}s`, matchers), time: period.time, refresh },
    { aggMode: AGG_MODE, queryType: 'query', expr: exprActiveTime(`${period.rangeSeconds}s`, matchers), time: period.time, refresh }
  ]
  const results2 = await runQueriesInWaves(env, specs2)

  const { byModel: tokensByModel, unknownTypes: modelUnknown } = parseTokensByModelVector(results2[0].data)
  const costByModel = parseCostByModelVector(results2[1].data)
  const activeTimeSeconds = parseSingleValueVector(results2[2].data, { valueTransform: roundNonNegative })
  for (const t of modelUnknown) overview.unknownTypes.add(t)

  // matchers가 employee_id="<employeeId>" 하나뿐이라 overview.byUnit에는 그 직원의 unit(계정별)만
  // 남는다 — foldToEmployees로 접어 단일 일자별 합계(entry.days) + 계정별 기간합계(group_accounts)를
  // 함께 얻는다(§7.3 "응답에 employee_id·group_accounts를 totals와 같은 최상위 레벨에 추가").
  const employees = foldToEmployees(overview.byUnit)
  const entry = employees.get(`emp:${employeeId}`)
  const rows = entry ? userDayRows(entry) : []
  const totals = entry ? userTotals(entry) : zeroTotals()
  totals.active_time_seconds = activeTimeSeconds
  const groupAccounts = entry ? groupAccountsOf(entry) : []

  return {
    notInMetrics: !entry,
    rows,
    totals,
    groupAccounts,
    byModel: mergeModelMaps(tokensByModel, costByModel),
    unknownTypes: overview.unknownTypes,
    meta: aggregateCacheMeta([...overview.rawResults, ...results2])
  }
}

// ---------------------------------------------------------------------------
// rev.2 하이브리드 합성(설계 §19.4, usage-employee-identity.md §5.1) — /summary·/users 공용.
// "완결일=D1 롤업 캐시 + 오늘=라이브"를 이 함수 안에서만 합성한다. /summary·/users는 반환된 byUnit
// Map을 축만 바꿔 접는다(daySummaryRows/mergeD1AndPromUsers, 기존 함수 그대로 재사용).
// ---------------------------------------------------------------------------

/** 캐시 구간 원본 행(day_at×employee_id×user_email 그레인)을 라이브와 동일한
 *  Map<unitKey,Map<dayAt,values>> 구조에 병합한다 — 이래야 §19.4가 요구하는 "캐시 행을 Map에 넣고
 *  라이브를 같은 Map에 병합"이 성립하고, daySummaryRows/userTotals/mergeD1AndPromUsers를 캐시·라이브
 *  어느 쪽 유래든 그대로 재사용할 수 있다(집계 로직 이중 구현 방지). D1에는 이미 '' 센티널로 저장돼
 *  있으므로(§8.1) 여기서 빈 문자열을 null로 정규화해 unitKeyOf/rowKeyOf가 라이브 유래 값과 동일하게
 *  다룬다. employee_name은 저장 시 이미 디코드됐으므로(usage-rollup.js) 다시 디코드하지 않는다. */
function mergeCacheRows(byUnit, rows) {
  for (const r of rows) {
    const employeeId = r.employee_id || null
    const userEmail = r.user_email || null
    const unitKey = unitKeyOf(employeeId, userEmail)
    let entry = byUnit.get(unitKey)
    if (!entry) {
      entry = { employeeId, userEmail, employeeNames: new Set(), days: new Map() }
      byUnit.set(unitKey, entry)
    }
    if (r.employee_name) entry.employeeNames.add(r.employee_name)
    const day = ensureDayEntry(entry, r.day_at)
    day.session_count += r.session_count
    day.input_tokens += r.input_tokens
    day.output_tokens += r.output_tokens
    day.cache_read_tokens += r.cache_read_tokens
    day.cache_write_tokens += r.cache_write_tokens
    day.cost_usd += r.cost_usd
  }
}

/** 캐시 Map과 라이브 Map을 결합한다. W2(§19.3)에 의해 같은 (unitKey,day)가 두 Map에 동시에 존재할
 *  수 없어야 한다 — 있으면 설계상 불가능해야 하는 이중계상 버그이므로 캐시 값을 보존하고 시끄럽게
 *  로그한다(§19.4 "키가 이미 있으면 그것은 버그다"). unitKey 자체가 (employeeId,userEmail) 그레인의
 *  Map 키이므로(§5.1의 서로소 증명 확장 — 키에 축이 하나 더 붙어도 §19.3-1 증명은 그대로 성립),
 *  옛 displayEmail 대소문자 보정 로직(m-6/n-1)은 더 이상 필요 없다 — 표시용 이메일은 D1
 *  users.email(d1_user 행) 또는 unit.userEmail(항상 소문자 저장, group_account/prometheus_only
 *  행)에서만 오고, PromQL 라이브 라벨의 원본 대소문자를 화면에 노출하는 경로가 없어졌다. */
function combineByUnitMaps(cacheByUnit, liveByUnit) {
  const combined = new Map()
  for (const [unitKey, entry] of cacheByUnit) {
    combined.set(unitKey, { employeeId: entry.employeeId, userEmail: entry.userEmail, employeeNames: new Set(entry.employeeNames), days: new Map(entry.days) })
  }
  for (const [unitKey, liveEntry] of liveByUnit) {
    let entry = combined.get(unitKey)
    if (!entry) {
      entry = { employeeId: liveEntry.employeeId, userEmail: liveEntry.userEmail, employeeNames: new Set(liveEntry.employeeNames), days: new Map() }
      combined.set(unitKey, entry)
    } else {
      for (const n of liveEntry.employeeNames) entry.employeeNames.add(n)
    }
    for (const [dayAt, values] of liveEntry.days) {
      if (entry.days.has(dayAt)) {
        console.error('[usage-prom] hybrid merge collision (cache+live both have this day) — keeping cache value', unitKey, dayAt)
        continue
      }
      entry.days.set(dayAt, values)
    }
  }
  return combined
}

/** 캐시 구간의 "구멍 없는 첫 프리픽스" 마지막 날(meta.rollup.cached_through, §17.6) — data_start부터
 *  오름차순으로 훑어 첫 결손(마커 없음 또는 agg_mode/norm_version 불일치)에서 멈춘다. 응답 예시
 *  (설계 §5.1 "부분 결손 예시")처럼 그 뒤에 유효한 날이 더 있어도 cached_through는 갱신하지 않는다
 *  — 이것이 "구멍 없이 연속 적재된 마지막 날"의 정의다. */
function computeCachedThrough(allCoverage, aggMode, normVersion) {
  if (!allCoverage.length) return null
  let cachedThrough = null
  let expected = allCoverage[0].day_at
  for (const row of allCoverage) {
    if (row.day_at !== expected) break
    if (row.agg_mode !== aggMode || row.norm_version !== normVersion) break
    cachedThrough = row.day_at
    expected = addDaysUTC(row.day_at, 1)
  }
  return cachedThrough
}

/** 오늘 요청(§19.2)에서만 호출 — "어제"를 앵커로 뒤로 훑어 캐시에 유효하게 존재하지 않는 트레일링
 *  구간을 찾는다(최대 LIVE_MAX_COMPLETE_DAYS일, from을 넘지 않음). 정상 상태(어제가 이미 캐시에
 *  있음)면 즉시 멈춰 null을 반환 — 이때 라이브 창은 오늘 부분일 하나뿐이다. */
export function computeLiveCompleteWindow({ from, anchor, coveredDays, maxDays }) {
  if (anchor < from) return null
  const days = []
  for (let cursor = anchor; cursor >= from && days.length < maxDays; cursor = addDaysUTC(cursor, -1)) {
    if (coveredDays.has(cursor)) break
    days.unshift(cursor)
  }
  return days.length ? { from: days[0], to: anchor } : null
}

/** gap_days(§20.1) — [from,to] 구간 중 coveredDays(캐시)에도 liveCoveredDays(라이브)에도 없는 날만
 *  뽑는다. M-5 단위테스트용으로 getUsageOverviewHybrid 본문에서 분리했다 — "0으로 위장하지 않고
 *  행 자체를 뺀다"는 이 함수 하나로 표현된다(0을 채워 넣는 코드 경로 자체가 없다). */
export function computeGapDays(from, to, coveredDays, liveCoveredDays) {
  return allDaysInRange(from, to).filter((d) => !coveredDays.has(d) && !liveCoveredDays.has(d))
}

/** /summary·/users 공용 하이브리드 조회(설계 §19.4 정본) — 완결일은 D1 롤업 캐시(usage_prom_daily),
 *  "오늘"(UTC)이 요청 범위에 포함될 때만 라이브를 시도한다. 완전 과거 범위(to < 오늘)는 라이브를
 *  전혀 부르지 않는다 — "오늘만 라이브"(architecture.md §0 결정29 개정)를 문자 그대로 지키고, 트레일링
 *  결손 보정(§20.2)은 "지금이 오늘"일 때만 의미가 있는 실시간 지연 보정이지 임의 과거 요청의 결손을
 *  메우는 장치가 아니다(중간 결손은 항상 gap_days로만 보고, §20.2 "중간 결손").
 *
 *  라이브 실패 시(§9.4 2단계): 캐시 구간에 단 하루라도 유효 데이터가 있으면 200 + live_unavailable
 *  true로 강등한다. 캐시도 전혀 없으면(신규 배포 직후 등) 원본 UpstreamError를 그대로 던져 호출부가
 *  기존 503 매핑을 타게 한다(§9.4 3단계 "그것도 없으면 503").
 *
 *  employeeId(usage-employee-identity.md §6.1, `GET /api/usage/me`·`/users/:id`가 신규로 넘긴다) —
 *  생략하면 기존 /summary·/users와 완전히 동일하게 무필터(전사). 값을 주면 resolveEmployeeScope()가
 *  캐시(D1 SQL 파라미터)·라이브(PromQL 라벨 매처) 양쪽을 그 직원 하나로 좁힌다 — 호출부가 반환된
 *  byUnit Map에서 다른 직원 키를 절대 받을 수 없다(스코프가 조회 단계에서부터 걸린다, 응답 필터링이
 *  아니다).
 *
 *  requireEmployeeScope(usage-employee-identity-linking.md §4.2 I7 안전망) — true인데
 *  resolveEmployeeScope(employeeId).scoped===false(=employeeId가 없거나 빈 값)이면 상류·D1 조회
 *  자체를 시작하지 않고 빈 스냅샷을 반환한다. scoped===false는 "무필터(전사)"를 뜻하므로, 스코프가
 *  요구되는 호출(본인 조회 `/me`·드릴다운)에서 이 값을 그대로 흘리면 일반 직원이 전사 사용량을 보는
 *  사고가 된다. 라우트의 조기 반환(1차 방어, server/api/usage.js)이 실수로 빠지더라도 이 가드가
 *  최종 방어선이다 — DAO(readHybridSnapshot)는 employeeIdFilter=null을 "무필터"로 해석하도록
 *  이미 설계돼 있어(§8 하위호환) 그 계층에서는 이 사고를 막을 수 없다. */
export async function getUsageOverviewHybrid(env, { from, to, refresh, employeeId, requireEmployeeScope = false } = {}) {
  const nowMs = Date.now() // m-1 — 이 요청 전체에서 "지금"을 한 번만 고정해 아래로 그대로 넘긴다
  const scope = resolveEmployeeScope(employeeId)

  if (requireEmployeeScope && !scope.scoped) {
    const guardTodayStr = todayUTCString(nowMs)
    const guardClampedTo = to > guardTodayStr ? guardTodayStr : to
    return {
      byUnit: new Map(),
      unknownTypes: new Set(),
      cacheMeta: aggregateCacheMeta([]),
      dataStart: null,
      segments: { cached: null, live: null },
      gapDays: allDaysInRange(from, guardClampedTo),
      rollup: { cached_through: null, last_sync_at: null, agg_mode: AGG_MODE },
      liveUnavailable: false
    }
  }

  const todayStr = todayUTCString(nowMs)
  const clampedTo = to > todayStr ? todayStr : to // §19.4 미래 클램프
  const isToday = clampedTo === todayStr
  const yesterday = addDaysUTC(todayStr, -1)
  const cacheTo = isToday ? yesterday : clampedTo // 오늘은 캐시에 존재할 수 없다(W1)

  const snapshot = await readHybridSnapshot(env.DB, from, cacheTo, AGG_MODE, NORM_VERSION, scope.employeeId)

  const cacheByUnit = new Map()
  mergeCacheRows(cacheByUnit, snapshot.validRows)

  const cacheUnknown = new Set()
  const coveredDays = new Set()
  for (const cov of snapshot.coverageInRange) {
    if (cov.agg_mode !== AGG_MODE || cov.norm_version !== NORM_VERSION) continue
    // M-3 수정(리뷰 2026-09-07) — 스코프 조회(scope.scoped, 예: GET /api/usage/me)에서는 레거시
    // employee_id='' 행이 SQL 파라미터 필터(readHybridSnapshot의 d.employee_id=?5)로 이미 빠져
    // 있으므로, 그 날짜를 "확정 0"으로 보이게 두지 않고 정직하게 gap_days로 되돌린다(§20.1 "0으로
    // 위장하지 않는다"). 전사 뷰(scope.scoped===false)는 결정30이 요구한 대로 identity_version을
    // 보지 않는다 — 레거시 데이터가 unk: 행으로 총합에 남아야 하고(read judgment는 agg_mode+
    // norm_version만), 여기서 걸러내면 총합 보존이 깨진다(T-1 트레이드오프, 스코프 축에서만 적용).
    if (scope.scoped && cov.identity_version !== IDENTITY_VERSION) continue
    coveredDays.add(cov.day_at)
    if (cov.unknown_types_json) {
      try {
        for (const t of JSON.parse(cov.unknown_types_json)) cacheUnknown.add(t)
      } catch (err) {
        console.error('[usage-prom] unknown_types_json parse failed (ignored)', cov.day_at, err)
      }
    }
  }

  let liveWindow = null
  let liveTodayIncluded = false
  let liveByUnit = new Map()
  let liveUnknown = new Set()
  let liveResults = []
  let liveErr = null

  // usage-employee-identity.md §6.2 I1 — scoped인데 safe가 아니면(§4.4 라벨 인젝션 위험 문자, 실무상
  // 거의 발생하지 않지만 방어선은 항상 켜져 있어야 한다) 라이브 질의 자체를 생략한다. matchers를
  // 빈 배열로 두고 그대로 질의하면 "안전하지 않은 employeeId"가 "무필터(전사)"로 뒤집혀 스코프가
  // 깨진다 — 이 경우 오늘 구간은 gap_days로 정직하게 빠지고, 캐시 구간(이미 SQL로 스코프됨)만 응답한다.
  if (isToday && (!scope.scoped || scope.safe)) {
    liveWindow = computeLiveCompleteWindow({ from, anchor: yesterday, coveredDays, maxDays: LIVE_MAX_COMPLETE_DAYS })
    const grid = liveWindow ? dayGridWindow(liveWindow.from, liveWindow.to, nowMs) : null
    const todayW = todayPartialWindow(clampedTo, nowMs)
    liveTodayIncluded = !!todayW
    try {
      // M-1 수정(리뷰 2026-09-03): 예산은 "라이브 구간 질의"에만 건다 — 이 함수 밖(usage.js)에서
      // getUsageOverviewHybrid() 전체를 withRouteBudget으로 감싸면, 이미 D1에서 읽어 둔 캐시 구간
      // (cacheByUnit, snapshot 등)까지 예산 초과 시 통째로 버려지고 응답이 503이 된다 — 상류가
      // "죽었을 때"보다 "느리기만 할 때" 더 나쁜 응답이 나가는 역설이 여기서 생겼다. 예산 타이머를
      // 라이브 질의 promise 하나에만 걸고, 초과분은 즉시 아래 catch에서 liveErr로 흡수해 캐시
      // 구간은 그대로 살린다(§9.4 2단계 "캐시가 있으면 200 + live_unavailable").
      liveResults = await withRouteBudget(runOverviewSpecsAndMerge(env, { grid, today: todayW, refresh, matchers: scope.matchers, byUnit: liveByUnit, unknownTypes: liveUnknown, nowMs }))
    } catch (err) {
      if (err && err.name === 'UpstreamError') {
        liveErr = err
      } else {
        throw err
      }
    }
  }

  // §9.4 3단계 — 캐시도 전혀 없는데 라이브까지 실패하면 진짜 전면 장애다. 그대로 던져 기존
  // 503 UPSTREAM_UNAVAILABLE 매핑을 타게 한다(호출부는 손대지 않는다).
  if (liveErr && coveredDays.size === 0) throw liveErr

  const liveUnavailable = !!liveErr
  const effectiveLiveByUnit = liveUnavailable ? new Map() : liveByUnit
  const effectiveLiveUnknown = liveUnavailable ? new Set() : liveUnknown

  const combined = combineByUnitMaps(cacheByUnit, effectiveLiveByUnit)
  const unknownTypes = new Set([...cacheUnknown, ...effectiveLiveUnknown])

  // gap_days(§20.1) — 요청 범위 중 캐시로도 라이브로도 못 채운 날. 0으로 위장하지 않고 행 자체를 뺀다.
  const liveCoveredDays = new Set()
  if (!liveUnavailable) {
    if (liveWindow) for (const d of allDaysInRange(liveWindow.from, liveWindow.to)) liveCoveredDays.add(d)
    if (liveTodayIncluded) liveCoveredDays.add(todayStr)
  }
  const gapDays = computeGapDays(from, clampedTo, coveredDays, liveCoveredDays)

  // segments(§5.0·§17.6) — cached는 "이번 응답이 캐시에서 실제로 읽어온 범위"(내부에 구멍이 있어도
  // 그대로), live는 실제로 시도해 성공한 범위(실패 시 null).
  const segmentsCached = from <= cacheTo ? { from, to: cacheTo } : null
  let segmentsLive = null
  if (isToday && !liveUnavailable) {
    segmentsLive = { from: liveWindow ? liveWindow.from : todayStr, to: todayStr }
  }

  const cachedThrough = computeCachedThrough(snapshot.allCoverage, AGG_MODE, NORM_VERSION)

  // m-3 수정(리뷰 2026-09-03) — to<오늘인 순수 캐시 응답(!isToday)은 라이브를 아예 시도하지 않아
  // liveResults가 항상 []이고, aggregateCacheMeta([])의 기본값(hit:true, fetched_at:new Date())이
  // "방금 상류에서 가져온 신선한 값"처럼 보이게 만들었다 — 실제로는 며칠 전 Cron 적재분이다.
  // rollup.last_sync_at(진짜 적재 시각)을 fetched_at으로 쓰고 age_seconds도 그 시각 기준으로 계산해
  // meta.cache/fetched_at이 실제 데이터 신선도를 정직하게 반영하게 한다(source는 여전히 'prometheus'
  // 고정 — 이 값도 결국 Prometheus 유래이지 자체수집이 아니다, §5.0).
  let cacheMeta
  if (!isToday) {
    const lastSyncMs = snapshot.lastSyncAt ? Date.parse(snapshot.lastSyncAt) : NaN
    cacheMeta = {
      hit: true,
      age_seconds: Number.isFinite(lastSyncMs) ? Math.max(0, Math.round((nowMs - lastSyncMs) / 1000)) : 0,
      ttl_seconds: 0, // D1 롤업 캐시에는 인메모리 TTL 개념이 없다(§7의 60초 TTL은 라이브 전용) — 0으로 구분
      stale: false,
      fetched_at: snapshot.lastSyncAt || new Date(nowMs).toISOString(),
      refresh_throttled: false
    }
  } else {
    cacheMeta = aggregateCacheMeta(liveUnavailable ? [] : liveResults)
  }

  return {
    byUnit: combined,
    unknownTypes,
    cacheMeta,
    dataStart: snapshot.dataStart,
    segments: { cached: segmentsCached, live: segmentsLive },
    gapDays,
    rollup: { cached_through: cachedThrough, last_sync_at: snapshot.lastSyncAt, agg_mode: AGG_MODE },
    liveUnavailable
  }
}
