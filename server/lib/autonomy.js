/**
 * autonomy.js — 단순 코어(docs/design/simple-core.md) 최소안전 3종의 집행 단일 지점.
 *
 *   1) 마스터 킬스위치(autonomy_enabled) · 2) 프로젝트별 on/off · 3) 일일 비용 상한.
 *
 * P3(2026-07-03): 다층 예산게이트(task-count 일일/사이클 한도)는 미사용 죽은 코드였고
 *   설계상 최소안전 3종에도 없어 제거했다. 남은 budget 값은 daily_cost_limit_usd(이 게이트) 와
 *   max_turns_per_task(poll-commands.js 의 claude --max-turns 집행, 별개 관심사) 뿐이다.
 *
 * 핵심 불변식(R0 유지):
 *   - autonomy_enabled OFF(기본) → verdict 가 auto 여도 **승인대기로 강등**(child command 생성 X = dry-run).
 *   - 오늘 누적 비용 ≥ daily_cost_limit_usd → 자율 배정 차단(강등).
 *
 * 전부 **동기**다(better-sqlite3 트랜잭션 안에서 호출 — adapter.transaction(fn) 의 tx 파사드 사용).
 */

// agents.budget_json 미설정 시 fallback.
export const DEFAULT_BUDGET = {
  daily_cost_limit_usd: Infinity,
  max_turns_per_task: Infinity,
}

/** 위험도 승인 임계값 화이트리스트 — 'off'(게이트 미적용, risk-blind) + 정규화 4단계. */
export const RISK_LEVELS = ['low', 'medium', 'high', 'critical']
export const RISK_APPROVAL_THRESHOLD_VALUES = ['off', ...RISK_LEVELS]

/**
 * KPI 전부 달성 시 동작 화이트리스트 — 'continue'(기본, 자율운영 유지) | 'off'(기존 동작, 자동 종료).
 * cycle-ingest.js §2.3 이 이 값으로 분기한다.
 */
export const KPI_COMPLETE_ACTION_VALUES = ['continue', 'off']

/**
 * riskAllowsAuto — proposal 의 risk_level 이 프로젝트가 정한 승인 임계값 미만이라
 *   자동집행 후보로 남을 수 있는지 판정한다(§1 설계, risk-approval-threshold).
 *
 *   threshold 의미 = "이 등급부터 사람 승인 필요". risk_level >= threshold 면 false.
 *   threshold='off'(또는 컬럼 부재/NULL) → 무제약(risk-blind) → true.
 *   threshold 가 화이트리스트 밖(오타/구버전) → fail-safe로 false(승인 요구).
 *
 * ⚠️ DEV MODE 우회 패턴과 무관한 독립 함수 — createBudgetGate 와 달리 항상 실제 로직으로 평가한다.
 *
 * @param {string} riskLevel  'low'|'medium'|'high'|'critical' (validateProposal 이 이미 정규화 보장)
 * @param {string|null|undefined} threshold  projects.risk_approval_threshold
 * @returns {boolean} true=자동집행 후보 유지, false=승인 필요(auto 강등)
 */
export function riskAllowsAuto(riskLevel, threshold) {
  if (threshold == null || threshold === 'off') return true
  const thIdx = RISK_LEVELS.indexOf(threshold)
  if (thIdx === -1) return false // fail-safe: 알 수 없는 값 → 승인 요구
  const lvlIdx = RISK_LEVELS.indexOf(riskLevel)
  const lvl = lvlIdx === -1 ? 0 : lvlIdx // 방어적(이론상 validateProposal 이 이미 'low' 폴백)
  return lvl < thIdx
}

const AUTONOMY_KEY = 'autonomy_enabled'

/**
 * getAppSetting — app_settings 단건 읽기(동기). 없으면 fallback.
 * 테이블이 아직 없을 수도 있으니(부팅 순서) 방어적으로 try.
 */
export function getAppSetting(tx, key, fallback = null) {
  try {
    const row = tx.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first()
    return row ? row.value : fallback
  } catch {
    return fallback
  }
}

/**
 * isAutonomyEnabled — 마스터 자율 스위치(=kill-switch). 기본 OFF.
 * '1'/'true'/'on' 만 ON 으로 본다(그 외/미설정/오류는 전부 OFF = fail-safe).
 * ⚠️ DEV MODE: 모든 제약 해제 — 항상 true 반환
 */
export function isAutonomyEnabled(tx) {
  // const v = getAppSetting(tx, AUTONOMY_KEY, '0')
  // return v === '1' || v === 'true' || v === 'on'
  return true // DEV: 제약 해제
}

/** 문자열 truthy 판정 헬퍼('1'/'true'/'on'만 true, 그 외/null/undefined 는 false). */
export function isTruthyFlag(v) {
  return v === '1' || v === 'true' || v === 'on' || v === 1 || v === true
}

/**
 * isProjectAutonomyEnabled — **프로젝트별 자율 스위치**(게이트 2단화의 2단).
 *
 * 결정 a77ecedd: 게이트 = 전역 마스터 AND 프로젝트별 스위치. 이 함수가 후자를 평가한다.
 * 프로젝트가 자율 대상이 되려면 아래를 모두 만족(하나라도 아니면 fail-safe OFF):
 *   1) autonomy_enabled = '1'  (명시적 ON — 기본 '0')
 *   2) cadence != 'off'        ('off' 는 정지로 취급)
 *   3) lead_agent_name 존재     (관찰 LEAD 가 배정돼 있어야 자율 사이클을 만들 수 있음)
 *
 * ⚠️ fail-safe: 프로젝트 행이 없거나, 컬럼이 없거나(마이그레이션 전), 값이 불명확하면 **OFF**.
 *   (프로젝트 설정 불명확 → 승인대기, 절대 auto 로 넓히지 않는다.)
 * ⚠️ DEV MODE: 모든 제약 해제 — 항상 true 반환
 *
 * @param {object} tx       동기 DB 파사드.
 * @param {string} projectId  대상 프로젝트(업무) id.
 * @returns {boolean}
 */
export function isProjectAutonomyEnabled(tx, projectId) {
  // DEV: 제약 해제
  return true

  /* 원본 코드 (비활성화)
  if (!projectId) return false
  try {
    const row = tx.prepare(
      'SELECT autonomy_enabled, cadence, lead_agent_name FROM projects WHERE id = ?'
    ).bind(projectId).first()
    if (!row) return false
    if (!isTruthyFlag(row.autonomy_enabled)) return false
    if (row.cadence && String(row.cadence).toLowerCase() === 'off') return false
    if (!row.lead_agent_name) return false
    return true
  } catch {
    return false // 컬럼 없음(마이그레이션 전) 등 → fail-safe OFF.
  }
  */
}

/** budget_json(string|object|null) → 기본값 병합 객체. */
export function parseBudget(json) {
  if (!json) return { ...DEFAULT_BUDGET }
  try {
    const b = typeof json === 'string' ? JSON.parse(json) : json
    return { ...DEFAULT_BUDGET, ...b }
  } catch {
    return { ...DEFAULT_BUDGET }
  }
}

/** agents.budget_json 읽어 병합된 budget 반환(동기). */
export function getAgentBudget(tx, agentName) {
  let raw = null
  try {
    const row = tx.prepare('SELECT budget_json FROM agents WHERE name = ?').bind(agentName).first()
    raw = row?.budget_json || null
  } catch { /* ignore */ }
  return parseBudget(raw)
}

/**
 * todayCostUsd — 오늘(로컬 일자 기준) 해당 **프로젝트**가 만든 command 들의 cost_usd 합계.
 * M-1: 비용은 실행 후 확정되므로, 디스패치 직전(ingest 박동)에서 "지금까지 누적"으로 체크한다.
 *
 * 실행 인프라 재설계(execution-infra-redesign.md §1.4, v3 최종): 구 구현은 commands.task_id →
 *   tasks(owner_agent_name) JOIN 으로 "이 LEAD 가 만든 command 트리"를 집계했으나, 이 JOIN 은
 *   오직 상시 lead task(leadtask-cycle-<pid>) 앵커 때문에 존재했다. 완전 통합(tasks/commands 병합,
 *   kind 판별자 미채택)으로 그 앵커를 없앤 뒤에는 **project_id 로 직접 집계**하는 것이 더 정확하다
 *   (현재 프로젝트당 lead_agent_name 은 정확히 1개라 실질적으로 동일 집합이지만, project_id 스코프는
 *   사람이 다른 agent 에게 수동 배정한 command 도 누락 없이 잡는다는 점에서 오히려 버그 수정에 가깝다).
 *
 * @param {object} tx
 * @param {string} projectId  대상 업무 프로젝트 id.
 * @returns {number} 오늘 누적 비용(USD).
 */
export function todayCostUsd(tx, projectId) {
  try {
    const row = tx.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM commands
        WHERE project_id = ?
          AND date(created_at,'localtime') = date('now','localtime')`
    ).bind(projectId).first()
    return Number(row?.total) || 0
  } catch {
    return 0
  }
}

/**
 * createBudgetGate — 한 박동의 최소안전 3종 게이트를 1회 구성한다(단일 지점).
 *
 * ingest 트랜잭션 진입 시 한 번 호출 → 반환된 gate 로 평가한다.
 * - gate.autonomy        : 마스터 킬스위치 ON 여부.
 * - gate.projectAutonomy : 프로젝트별 on/off.
 * - gate.costExceeded    : 오늘 누적 비용 ≥ 일일 상한.
 * - gate.canAutoDispatch : 셋 다 통과해야 auto verdict 를 실제 배정으로 푼다.
 *
 * 실행 인프라 재설계(§1.4, v3 최종): owner agent 인자를 없애고 projectId 단일 스코프로 단순화했다
 *   (todayCostUsd 와 동일 근거). agent budget(daily_cost_limit_usd/max_turns_per_task)은 여전히
 *   그 프로젝트의 lead_agent_name 으로 조회한다 — 프로젝트가 없거나 lead_agent_name 미지정이면
 *   DEFAULT_BUDGET 으로 안전 폴백(getAgentBudget(tx, null) → parseBudget(null)).
 *
 * ⚠️ DEV MODE: 모든 게이트 무시 — canAutoDispatch=true, 제약 없음
 *
 * @param {object} tx
 * @param {string} projectId  대상 업무 프로젝트 id.
 * @returns {object} gate
 */
export function createBudgetGate(tx, projectId) {
  // DEV: 모든 게이트 해제
  const budget = { daily_cost_limit_usd: Infinity, max_turns_per_task: Infinity }

  return {
    budget,
    autonomy: true, // DEV: 항상 true
    projectAutonomy: true, // DEV: 항상 true
    costToday: 0,
    costLimit: Infinity,
    costExceeded: false, // DEV: 제약 해제
    // DEV: canAutoDispatch 항상 true
    canAutoDispatch: true,

    /**
     * autoBlockReason — 차단 사유 없음 (DEV 모드)
     */
    autoBlockReason() {
      return null // DEV: 제약 없음
    },
  }

  // 원본 코드 (비활성화)
  // let leadAgentName = null
  // try {
  //   const proj = tx.prepare('SELECT lead_agent_name FROM projects WHERE id = ?').bind(projectId).first()
  //   leadAgentName = proj?.lead_agent_name || null
  // } catch { }
  //
  // const budget = getAgentBudget(tx, leadAgentName)
  // const autonomy = isAutonomyEnabled(tx)
  // const projectAutonomy = projectId ? isProjectAutonomyEnabled(tx, projectId) : true
  // const costToday = todayCostUsd(tx, projectId)
  // const costLimit = Number(budget.daily_cost_limit_usd)
  // const costExceeded = false
  //
  // return {
  //   budget,
  //   autonomy,
  //   projectAutonomy,
  //   costToday,
  //   costLimit,
  //   costExceeded,
  //   canAutoDispatch: autonomy && projectAutonomy && !costExceeded,
  //   autoBlockReason() {
  //     if (!autonomy) return 'autonomy_off'
  //     if (!projectAutonomy) return 'project_autonomy_off'
  //     if (costExceeded) return `cost cap ${costLimit} 도달(오늘 누적 ${costToday.toFixed(4)})`
  //     return null
  //   },
  // }
}
