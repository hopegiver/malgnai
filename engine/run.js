#!/usr/bin/env node
/**
 * engine/run.js — 엔진 launchd 엔트리포인트(Phase 2, docs/design/engine-webapp-separation.md §5).
 *
 * ⚠️ 캐너리(기본 비활성): `app_settings.engine.tick_enabled`가 '0'(기본값)이면 이 틱은 즉시
 *   종료한다 — 기존 `com.malgnai.loop`(bin/loop.js, 실제 실행경로)를 대체하지 않는다. 트래픽이
 *   적은 시간대에 `com.malgnai.loop`를 멈추고 `engine.tick_enabled='1'`로 전환해야만 이 job이
 *   실제로 일을 시작한다(§5 Phase 2 캐너리 절차 — 이번 스코프는 "기본 비활성으로 안전 대기"까지).
 *
 * 이 프로세스는 HTTP 를 전혀 쓰지 않는다(fetch/포트 바인딩 없음) — 웹서버가 죽어 있어도 동작한다
 *   (§1 배경 문제 2 해소). 공유 지점은 오직 같은 sqlite 파일(engine/db.js) 하나다.
 *
 * 틱 순서: (1) isTickEnabled 확인 → false 면 즉시 종료 → (2) runSpawnDue(db) → (3) safetyPollOnce(db).
 *
 * §6 리스크 "fire-and-forget → 프로세스 조기 종료": runSpawnDue 가 스폰 직후 시작하는
 *   dispatchApprovedCommand(...) 는 원래 fire-and-forget 이다(상시 프로세스인 웹앱은 안전하지만,
 *   매 틱 종료하는 엔진은 그 실행이 끝나기 전에 프로세스가 죽으면 사이클이 잘릴 위험이 있다).
 *   그래서 이 틱에서 pendingDispatches 배열을 만들어 runSpawnDue 에 넘기고, 틱을 끝내기 전에
 *   Promise.allSettled 로 전부 기다린다(engine/spawn.js 의 JSDoc 참고 — 두 번째 인자를 안 넘기는
 *   기존 호출부(server/api/lead.js)는 지금과 동일하게 fire-and-forget 으로 남는다).
 *   safetyPollOnce 는 이미 순차 await 구조라(claim→exec→결과반영 한 줄로 이어짐) 이 문제가 없다.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'

import { openEngineDb, ROOT } from './db.js'
import { isTickEnabled } from './settings.js'
import { runSpawnDue } from './spawn.js'
import { safetyPollOnce } from './safety-poll.js'

const LOG_DIR = join(ROOT, 'logs')
const LOG_FILE = join(LOG_DIR, 'engine.log')

function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), source: 'run', ...obj })
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line + '\n')
  } catch { /* 로깅 실패는 무시 */ }
  console.log('[engine:run]', line)
}

/**
 * runEngineTick — 엔진 1틱의 전체 로직(db 를 인자로 받는 순수 async 함수 — 단위 테스트에서
 *   실제 launchd 프로세스 기동 없이 인메모리 db 로 호출 가능).
 * @param {object} db  D1 호환 어댑터(engine/db.js 의 openEngineDb().db 또는 테스트용 인메모리).
 * @returns {Promise<{skipped:boolean, reason?:string, spawnResult?:object, pollResult?:object}>}
 */
export async function runEngineTick(db) {
  // 가장 먼저 확인 — 캐너리의 핵심 안전장치(§5 Phase 2).
  if (!isTickEnabled(db)) {
    logLine({ event: 'tick_skipped', reason: 'tick_disabled' })
    return { skipped: true, reason: 'tick_disabled' }
  }

  const pendingDispatches = []
  const spawnResult = await runSpawnDue(db, pendingDispatches)

  // §6 리스크: 이 틱에서 시작한 모든 스폰 디스패치가 끝난 뒤에만 다음 단계(및 프로세스 종료)로 진행.
  if (pendingDispatches.length) {
    await Promise.allSettled(pendingDispatches)
  }

  const pollResult = await safetyPollOnce(db)

  logLine({ event: 'tick_done', spawn: spawnResult, poll: pollResult })
  return { skipped: false, spawnResult, pollResult }
}

async function main() {
  const { db, close } = openEngineDb()
  try {
    await runEngineTick(db)
  } catch (e) {
    logLine({ event: 'tick_error', error: e.message })
  } finally {
    // 틱 끝에 DB 명시적 close(§2 "open/close 를 export 해서 명시적으로 닫을 수 있게" 요구사항).
    close()
  }
}

// launchd 가 이 파일을 직접 실행할 때만 main() 을 돈다 — 테스트가 runEngineTick 을 import 해서
// 쓸 때는 이 블록이 실행되지 않는다(process.argv[1] 이 이 파일이 아니므로).
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url)
if (isMainModule) {
  main().then(() => process.exit(0))
}
