/**
 * engine/settings.js — app_settings 의 engine.* 키를 읽는 얇은 typed getter 모음.
 *
 * docs/design/engine-webapp-separation.md §4.2 이관 대상 키를 코드에서 조회하는 단일 지점.
 * 실제 조회는 server/lib/autonomy.js 가 이미 export 하는 getAppSetting(tx, key, fallback)을
 * 재사용한다(중복 구현 금지 — 동일한 방어적 try/catch, 테이블 없거나 행 없으면 fallback).
 *
 * Phase 0(app_settings INSERT, commit 6e4768a)에서 이미 아래 키들이 하드코드값과 동일하게
 * 들어가 있으므로, 이 getter 를 도입해도 동작은 바뀌지 않는다(Phase 1 = 순수 리팩터).
 */
import { getAppSetting } from '../server/lib/autonomy.js'

export function getReapCutoffMinutes(tx) {
  return Number(getAppSetting(tx, 'engine.reap_cutoff_minutes', 60))
}

export function getConsecutiveFailureThreshold(tx) {
  return Number(getAppSetting(tx, 'engine.consecutive_failure_threshold', 10))
}

export function getRecentCyclesCount(tx) {
  return Number(getAppSetting(tx, 'engine.recent_cycles_count', 15))
}

export function getDailyCostLimitUsd(tx) {
  return Number(getAppSetting(tx, 'engine.daily_cost_limit_usd', 1000))
}

export function isTickEnabled(tx) {
  return getAppSetting(tx, 'engine.tick_enabled', '1') === '1'
}
