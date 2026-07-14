// activity-normalize.js — activity_logs 구조화 컬럼(level/category/result/links)의
// **단일 공용 정규화·폴백 함수**. (설계서 §10 B1: enum 계약 강제는 "웹 400 차단"이 아니라
// "서버측 정규화/폴백"이 유일 안전망이다.)
//
// 왜 400 을 던지지 않는가:
//   MCP `activity_log`(mcp/tools/activity.js)는 웹 POST 를 거치지 않고 **동일 sqlite 파일에 직접
//   INSERT**한다. 이 경로는 웹 POST 의 enum 400 검증을 아예 거치지 않으므로, 웹 POST 쪽에서 위반
//   값에 400 을 던지는 방식으로는 데이터 정합성을 보장할 수 없다. 따라서 웹 POST 는 위반 값에
//   400 을 던지지 않고 **안전 기본으로 교정**한다(MCP 직접쓰기와 대칭 유지). 이 함수가 그 유일 안전망이다.
//
// 이 모듈은 순수 함수만 노출한다(DB 무관) → POST 라우트·백필·(향후) 엔진 lib 이 공유.

// ── 닫힌 enum(§2.3) ──
export const ACTIVITY_LEVELS = ['work', 'telemetry', 'audit']
export const ACTIVITY_CATEGORIES = ['plan', 'design', 'build', 'verify', 'decision', 'deploy', 'ops', 'system']
export const ACTIVITY_RESULTS = ['success', 'failed', 'partial', 'skipped', 'pending']

// action(자유값) → category(닫힌 enum) 도출표(§2.3 백필 규칙과 동일 소스).
// 백필 SQL(init.js)의 CASE 와 값이 반드시 일치해야 한다.
const ACTION_CATEGORY = {
  create: 'build', implement: 'build', update: 'build',
  milestone: 'decision',
  config: 'deploy', engine_setting_update: 'deploy',
  app_setting_update: 'deploy', app_setting_delete: 'deploy',
  backfill: 'ops', bootstrap: 'ops', 'operator-activation': 'ops',
  rule_queue: 'system', rule_auto: 'system', worker_parse_fail: 'system',
  lead_parse_fail: 'system', diff_path_rejected: 'system', autonomy_toggle: 'system',
}

// system 엔진 텔레메트리 action 집합(level=telemetry 로 분류).
const SYSTEM_ACTIONS = new Set([
  'rule_queue', 'rule_auto', 'worker_parse_fail', 'lead_parse_fail',
  'diff_path_rejected', 'backfill_stat',
])
// 사람이 알아야 할 설정변경 감사 action(level=audit 예외 — §2.3 note).
// engine_setting_update(2026-07-12 신설, engine-webapp-separation.md §4.2/§7-5) — engine.* 튜닝값
// 변경은 자율 실행에 직접 영향을 주므로 autonomy_toggle과 동일하게 audit로 분류한다.
// app_setting_update/app_setting_delete(2026-07-13 신설, app_settings 범용 설정 화면) — 형제 라우트인
// engine_setting_update와 동일하게 설정값 변경/삭제는 감사 대상이므로 audit로 분류한다.
const AUDIT_ACTIONS = new Set([
  'autonomy_toggle', 'project_autonomy_update', 'config', 'engine_setting_update',
  'app_setting_update', 'app_setting_delete',
])

// action → category. 매칭 없으면 안전 기본 'ops'.
export function deriveCategory(action) {
  if (!action) return 'ops'
  return ACTION_CATEGORY[action] || 'ops'
}

// level 정규화: 유효 명시값이면 존중, 아니면 안전 기본.
//   우선순위: audit 예외(설정변경) > system(엔진) telemetry > work.
export function normalizeLevel({ level, agent_name, action } = {}) {
  if (ACTIVITY_LEVELS.includes(level)) return level
  if (AUDIT_ACTIONS.has(action)) return 'audit'
  if (agent_name === 'system' || SYSTEM_ACTIONS.has(action)) return 'telemetry'
  return 'work'
}

// category 정규화: 유효 명시값이면 존중, 아니면 action 매핑→ops.
export function normalizeCategory({ category, action } = {}) {
  if (ACTIVITY_CATEGORIES.includes(category)) return category
  return deriveCategory(action)
}

// result 정규화: 유효 enum 이면 존중, 그 외(위반/미지정/빈값)는 정보성 NULL 로 폴백(400 금지).
export function normalizeResult(result) {
  if (result === null || result === undefined || result === '') return null
  if (ACTIVITY_RESULTS.includes(result)) return result
  return null
}

// links(배열) 또는 links_json(문자열/객체) → 저장용 JSON 문자열. 파싱 불가/빈값이면 NULL.
export function normalizeLinksJson({ links, links_json } = {}) {
  if (links_json !== undefined && links_json !== null) {
    if (typeof links_json === 'string') {
      try { JSON.parse(links_json); return links_json } catch { return null }
    }
    try { return JSON.stringify(links_json) } catch { return null }
  }
  if (Array.isArray(links)) {
    try { return links.length ? JSON.stringify(links) : null } catch { return null }
  }
  return null
}

// title 도출: 명시값 우선, 없으면 detail 앞머리 120자(파생 요약 — detail 원문은 보존).
export function normalizeTitle({ title, detail } = {}) {
  if (title != null && String(title).trim() !== '') return String(title)
  if (detail != null && String(detail).trim() !== '') return String(detail).slice(0, 120)
  return null
}

// ── 통합 타임라인(§4.3) 읽기시점 매핑 — 매핑 단일 소스(projects.js timeline 이 import) ──
// task_type(commands/tasks) → activity category. 매핑 없으면 안전 기본 'ops'.
const TASKTYPE_CATEGORY = {
  implement: 'build', apply_diff: 'deploy', investigate_failure: 'verify',
  lead_cycle: 'ops', review: 'verify', design: 'design', plan: 'plan',
  build: 'build', deploy: 'deploy', verify: 'verify',
}
export function taskTypeToCategory(taskType) {
  return (taskType && TASKTYPE_CATEGORY[taskType]) || 'ops'
}
// command.status → result enum.
export function commandStatusToResult(status) {
  if (status === 'done') return 'success'
  if (status === 'failed' || status === 'rejected' || status === 'expired') return 'failed'
  return 'pending'
}
// task.status → result enum. (tasks CHECK: pending/in_progress/completed/failed)
export function taskStatusToResult(status) {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'failed'
  if (status === 'in_progress') return 'pending'
  return null
}

/**
 * normalizeActivity — POST/엔진 공용 단일 진입. 입력을 그대로 스프레드하되 구조화 필드를
 * 안전 기본으로 교정해 돌려준다. **detail 은 절대 변형하지 않는다.**
 * @param {object} input  { agent_name, action, detail, level?, category?, title?, target_ref?, result?, links?, links_json?, correlation_id?, ... }
 * @returns {object} input + { level, category, title, target_ref, result, links_json, correlation_id }
 */
export function normalizeActivity(input = {}) {
  return {
    ...input,
    level: normalizeLevel(input),
    category: normalizeCategory(input),
    title: normalizeTitle(input),
    target_ref: input.target_ref ?? null,
    result: normalizeResult(input.result),
    links_json: normalizeLinksJson(input),
    correlation_id: input.correlation_id ?? null,
  }
}
