/**
 * engine/spawn.js — 자율 스폰(spawn-due) 로직. server/api/lead.js 에서 이관(Phase 1, 순수 리팩터).
 *
 * docs/design/engine-webapp-separation.md §5 Phase 1:
 *   - checkConsecutiveFailures/spawnOneCycle 은 원래 Hono `c` 객체에 의존하지 않는 순수 함수라
 *     이동만 하면 된다(동작 변경 없음).
 *   - POST /spawn-due 핸들러 본문의 로직을 runSpawnDue(db) 로 추출해 HTTP 계층(server/api/lead.js)과
 *     엔진 계층을 분리한다. server/api/lead.js 의 라우트는 이 함수를 호출하는 얇은 wrapper로 축소됨.
 *   - REAP_CUTOFF/CONSECUTIVE_FAILURE_THRESHOLD/RECENT_CYCLES_COUNT 하드코드 상수는
 *     engine/settings.js 의 getter로 교체(Phase 0에서 이관해둔 app_settings.engine.* 값이 기존
 *     하드코드값과 동일해 동작 변화 없음).
 */
import { logActivity } from '../server/lib/activity-log.js'
import { createBudgetGate, isTruthyFlag } from '../server/lib/autonomy.js'
import { periodKeyForCadence, nextRunAtIso } from '../server/lib/cadence.js'
import { buildProjectCyclePrompt } from '../server/lib/project-cycle-prompt.js'
import { AUTONOMOUS_KINDS } from '../server/dao/init.js'
import { dispatchApprovedCommand } from '../server/lib/dispatch-worker.js'
import { resolveMaxTurns } from '../server/lib/tool-profiles.js'
import { getReapCutoffMinutes } from './settings.js'

/**
 * checkConsecutiveFailures — 프로젝트의 최근 사이클 실패 여부 진단(연속 실패 차단).
 *   최근 N개 사이클 중 M개 이상이 failed이면 자동으로 autonomy_enabled를 OFF 한다.
 *   근본 원인: 파싱 오류/프롬프트 문제 등으로 인한 사이클 실패의 무한 반복을 방지.
 * ⚠️ DEV MODE: 연속 실패 차단 비활성화 — 항상 shouldDisable=false
 * @returns {{shouldDisable: boolean, failureCount: number, recentCount: number}}
 */
export function checkConsecutiveFailures(tx, projectId) {
  // DEV: 연속 실패 차단 해제
  return { shouldDisable: false, failureCount: 0, recentCount: 0 }

  /* 원본 코드 (비활성화)
  try {
    const recent = tx.prepare(
      `SELECT status FROM commands
        WHERE project_id = ? AND task_type = 'project_cycle'
        ORDER BY created_at DESC
        LIMIT ?`
    ).bind(projectId, RECENT_CYCLES_COUNT).all()?.results || []

    if (recent.length === 0) return { shouldDisable: false, failureCount: 0, recentCount: 0 }

    const failureCount = recent.filter(c => c.status === 'failed').length
    const shouldDisable = recent.length >= RECENT_CYCLES_COUNT && failureCount >= CONSECUTIVE_FAILURE_THRESHOLD
    return { shouldDisable, failureCount, recentCount: recent.length }
  } catch {
    return { shouldDisable: false, failureCount: 0, recentCount: 0 }
  }
  */
}

/**
 * spawnOneCycle — 프로젝트 1개의 자율 사이클 스폰을 **단일 트랜잭션**으로 원자 처리(설계 §2.2-3).
 *   락 체크 + 예산(cost) 게이트 + project_cycle command INSERT + next_run_at 원자 갱신을
 *   한 tx 로 묶어 TOCTOU/이중스폰/주기드리프트를 원천 차단(B3 해소).
 *
 * 실행 인프라 재설계(§1.4, v3 최종): 구 (c)단계 "상시 lead task 확보"(leadtask-cycle-<pid> 행 생성)는
 *   완전 제거됐다 — 오직 todayCostUsd 의 commands.task_id→tasks.owner_agent_name 조인 때문에
 *   존재했는데, 그 함수가 project_id 직접집계로 바뀌어 앵커 자체가 불필요해졌다.
 *
 * §2.7(v3 신규): 반환값을 `{outcome, commandId}`로 확장했다(구 문자열 단독 반환에서). 호출부(§2.7
 *   for 루프)가 스폰된 command 의 id 를 알아야 dispatchApprovedCommand 로 즉시 디스패치할 수 있다
 *   — outcome==='spawned' 일 때만 commandId 를 채운다(이미 있던 지역변수 cmdId 를 반환에 얹기만 함).
 * @param {object} maxTurns  project_cycle 용 max_turns(resolveMaxTurns에서 미리 구한 값).
 * @returns {{outcome: 'spawned'|'locked'|'budget', commandId?: string}}
 */
export function spawnOneCycle(tx, p, now, maxTurns) {
  const iso = now.toISOString()

  // a) 프로젝트당 active-1 불변식(설계 vscode-web-unified-execution.md §7-3): 구 project_cycle 전용
  //    락을 **모든 task_type 공통**으로 일반화한다. 프로젝트에 살아있는(비terminal) command 가 하나라도
  //    있으면 — 정기 사이클이든, 승인 대기 proposal 이든, 실행 중 phase 든 — 새 사이클을 스폰하지 않는다.
  //    이로써 phase 는 자연히 순차가 되고(직전 phase 가 done 된 뒤에만 다음이 돎), 동시 실행 충돌
  //    표면이 사라진다. 승인 대기 중인 proposal 이 있으면 사이클도 멈춰 "사람 대기" 상태가 유지된다.
  const live = tx.prepare(
    `SELECT id FROM commands
       WHERE project_id=? AND status IN ('queued','approved','claimed','running') LIMIT 1`
  ).bind(p.id).first()
  if (live) return { outcome: 'locked' }

  // b) 예산-at-스폰(§2.7): cost 한도 초과면 스폰 skip(command 미생성=비용0). next_run_at 은 다음 주기로 미룸.
  const gate = createBudgetGate(tx, p.id)
  if (gate.costExceeded) {
    tx.prepare('UPDATE projects SET next_run_at=?, last_run_at=? WHERE id=?')
      .bind(nextRunAtIso(p.cadence, now), iso, p.id).run()
    logActivity(tx, {
      project_id: p.id, agent_name: 'system', action: 'cycle_budget_skip',
      detail: `cost cap ${gate.costLimit} 도달(오늘 누적 ${gate.costToday.toFixed(4)}) → 스폰 skip`, created_at: iso,
    })
    return { outcome: 'budget' }
  }

  // c) 멱등 스폰: idem = cycle-<pid>-<periodKey>. 부분 UNIQUE 인덱스(idx_commands_idem, WHERE
  //    idempotency_key IS NOT NULL)는 ON CONFLICT 타깃과 안 맞으므로, 이 코드베이스 관례대로
  //    **평문 INSERT + UNIQUE catch**(createScheduled 동형)로 동일 주기 중복을 차단한다.
  //
  //    reviewer 지적(High, §2.7 즉시디스패치 검증): 'queued'로 INSERT하면 이 함수 리턴 이후
  //    dispatchApprovedCommand(§2.3)가 'running'으로 전이하기 전까지 poll의 claim()(status IN
  //    ('queued','approved') 대상)이 그 틈을 노려 같은 row를 먼저 가져갈 수 있어 이중실행 위험이
  //    있었다. 그래서 이 INSERT 자체를 'claimed'(claimed_by='server-spawn-due')로 만들어 poll의
  //    claim() 대상에서 애초에 제외한다 — §2.4(사람 즉시스폰)가 reviewCommandTx의 타겟claim으로
  //    이미 'claimed' 상태를 만든 뒤 dispatchApprovedCommand를 부르는 것과 동일한 패턴.
  const periodKey = periodKeyForCadence(p.cadence, now)
  const idem = `cycle-${p.id}-${periodKey}`
  const cmdId = crypto.randomUUID()
  // (reviewer MAJOR-1, §6-3) 대표 수정요청(FEEDBACK memory)을 워커 프롬프트에 주입한다.
  //   request_changes 시 instant-dispatch.js 가 적재한 note 를 워커가 실제로 읽는 유일 채널(프롬프트)로
  //   흘려야 "다음 사이클이 수정 반영" 약속이 성립(write-only 고아 결함 해소). 최근 3일·최대 3건 한정으로
  //   오래된 피드백의 무한 재주입을 막는다.
  let feedbacks = []
  try {
    feedbacks = tx.prepare(
      `SELECT title, content FROM memories
        WHERE project_id=? AND memory_type='FEEDBACK' AND datetime(created_at) >= datetime('now','-3 days')
        ORDER BY created_at DESC LIMIT 3`
    ).bind(p.id).all()?.results || []
  } catch { /* 조회 실패는 치명 아님 — 피드백 없이 진행 */ }
  let spawned = false
  try {
    tx.prepare(
      `INSERT INTO commands (id, project_id, host, instruction, status, permission_mode, created_by,
                             created_at, updated_at, idempotency_key, task_type, business, risk_level,
                             ai_summary, claimed_by, claimed_at, max_turns)
       VALUES (?, ?, NULL, ?, 'claimed', 'allowlist', 'autoloop', ?, ?, ?, 'project_cycle', '업무', 'low', ?, 'server-spawn-due', ?, ?)`
    ).bind(cmdId, p.id, buildProjectCyclePrompt(p, feedbacks), iso, iso, idem,
      `[자동] ${p.name} 프로젝트 자율 박동`, iso, maxTurns).run()
    spawned = true
  } catch (e) {
    // 멱등키 충돌 = 이 주기 command 가 이미 존재 → 재스폰 안 함(lock 취급). 그 외 에러는 전파.
    const exists = tx.prepare('SELECT 1 FROM commands WHERE idempotency_key = ?').bind(idem).first()
    if (!exists) throw e
  }

  // d) next_run_at 원자 갱신(같은 tx) — due 게이트 전진(주기 드리프트 차단).
  tx.prepare('UPDATE projects SET next_run_at=?, last_run_at=? WHERE id=?')
    .bind(nextRunAtIso(p.cadence, now), iso, p.id).run()

  if (spawned) {
    logActivity(tx, {
      project_id: p.id, command_id: cmdId, agent_name: 'system', action: 'cycle_spawn',
      detail: `project_cycle 스폰: ${idem}`, created_at: iso,
    })
    return { outcome: 'spawned', commandId: cmdId }
  }
  return { outcome: 'locked' }  // 멱등 충돌(이미 이 주기 command 존재) = 재스폰 안 함.
}

/**
 * runSpawnDue — 분산 전환의 원자 스폰 결정점(설계 §2.2)의 순수 로직(HTTP 비의존).
 *
 * server/api/lead.js `POST /spawn-due` 핸들러(§C1)에서 이관. 스폰 결정 전부를 처리:
 *   1) reapStaleCycles → 2) master 게이트 → 3) due 열거 → 4) 각 프로젝트 단일 tx 스폰.
 *
 * engine/run.js 대응(§5 Phase 2, §6 리스크 "fire-and-forget → 프로세스 조기 종료"): 스폰 직후의
 *   `dispatchApprovedCommand(...)` 호출은 원래 fire-and-forget 이다(상시 프로세스인 웹앱은 이래도
 *   안전). 그러나 엔진은 매 틱 종료하는 짧은 프로세스라, 그 디스패치가 끝나기 전에 프로세스가 죽으면
 *   실행 중이던 사이클이 잘릴 수 있다. 이를 위해 `pendingDispatches`(선택, 배열)를 넘기면 이 함수가
 *   시작한 모든 디스패치 Promise 를 그 배열에 push 한다 — 호출부(engine/run.js)가 틱 종료 전에
 *   `Promise.allSettled(pendingDispatches)`로 전부 기다릴 수 있게 한다. 인자를 안 넘기면(기존
 *   `server/api/lead.js` 의 `POST /spawn-due` 호출부처럼) 지금과 100% 동일하게 fire-and-forget
 *   으로 동작한다(웹앱 경로 무변경).
 * @param {object} db  D1 호환 어댑터(better-sqlite3 wrap).
 * @param {Array<Promise>} [pendingDispatches]  제공 시, 이 틱에서 시작한 dispatch Promise 들을 push.
 * @returns {{master_enabled: boolean, scanned: number, spawned: number, locked_skip: number, budget_skip: number, reaped: number}}
 */
export async function runSpawnDue(db, pendingDispatches) {
  const now = new Date()
  const nowIsoStr = now.toISOString()
  const out = { master_enabled: false, scanned: 0, spawned: 0, locked_skip: 0, budget_skip: 0, reaped: 0 }

  // 1) reapStaleCycles: 오래 claimed/running 인 command 전체 → failed(락 해제·장애복구).
  //    실행 인프라 재설계(§2.5, v3 최종): task_type='project_cycle' 필터를 제거해 claimed/running
  //    전체로 reap 대상을 넓혔다 — 즉시스폰된 사람 커맨드(claimed_by='server-immediate')는 이
  //    필터에 안 걸려 영원히 claimed 로 남을 수 있었다(decision d01d3834 전제 정정). 넓히기는 순수
  //    이득이고 부작용 없음(기존에도 있었던 "poll claim 후 poll 프로세스 죽음" 갭도 부수적으로 해소).
  try {
    const reapCutoff = '-' + getReapCutoffMinutes(db) + ' minutes'
    const r = await db.prepare(
      // [reviewer MAJOR-1] updated_at 은 ISO-T('...T..Z'), datetime('now',?)는 공백형식이라
      //   원시 TEXT 비교가 'T'(0x54)>' '(0x20)로 항상 false → stale 미회수(영구 락).
      //   양쪽을 datetime()으로 정규화해 비교한다.
      `UPDATE commands SET status='failed', error='stale cycle reaped', updated_at=?
         WHERE status IN ('claimed','running')
           AND datetime(updated_at) < datetime('now', ?)`
    ).bind(nowIsoStr, reapCutoff).run()
    out.reaped = r?.meta?.changes || 0
  } catch { /* best-effort */ }

  // 2) 마스터 자율 스위치(kill-switch). OFF 면 즉시 종료(비용0).
  const autoRow = await db.prepare("SELECT value FROM app_settings WHERE key = 'autonomy_enabled'").first()
  out.master_enabled = autoRow ? isTruthyFlag(autoRow.value) : false
  if (!out.master_enabled) return out

  // 3) due 프로젝트 열거(kind 화이트리스트 + 프로젝트 자율 ON + lead_agent_name 존재 + next_run_at due).
  let rows = []
  try {
    const kindPlaceholders = AUTONOMOUS_KINDS.map(() => '?').join(',')
    rows = (await db.prepare(
      `SELECT id, name, goal, kpi_json, lead_agent_name, cadence, next_run_at, custom_instruction
         FROM projects
        WHERE kind IN (${kindPlaceholders})
          AND (autonomy_enabled='1' OR autonomy_enabled='true' OR autonomy_enabled='on')
          AND lead_agent_name IS NOT NULL AND lead_agent_name != ''
          AND (cadence IS NULL OR LOWER(cadence) != 'off')
          AND (next_run_at IS NULL OR next_run_at <= ?)
        ORDER BY name ASC`
    ).bind(...AUTONOMOUS_KINDS, nowIsoStr).all()).results
  } catch { rows = [] }
  out.scanned = rows.length

  // 4) 각 프로젝트 원자 tx 스폰(하나가 실패해도 나머지는 진행).
  //    §2.7(v3 신규): outcome==='spawned' 이면 tx 종료 직후(DB 잠금을 오래 잡지 않도록 tx 바깥에서)
  //    dispatchApprovedCommand(§2.3, 사람 즉시스폰과 완전히 동일한 함수)를 fire-and-forget 으로
  //    호출한다. 신규 동시상한 메커니즘(세마포어 등)은 만들지 않는다(대표가 명시 기각, memory
  //    adc726c6→151b5c89) — 기존 프로젝트별 락(spawnOneCycle의 a단계)과 project_id 스코프
  //    예산게이트(§1.4)만으로 프로젝트간 동시 디스패치 안전성이 충분하다는 게 최종 결론.
  //    (신규) 연속 실패 차단: 최근 5개 사이클 중 4개 이상이 failed이면 자동으로 autonomy OFF.
  //    2026-07-10(mycerti 근본 수정): spawn 시에도 resolveMaxTurns()를 호출해 max_turns 설정
  //    → poll 경로에서 미설정 NULL을 받아 기본값 8턴 제약이 생기던 버그 해소(issue dd59cc34).
  for (const p of rows) {
    try {
      // 연속 실패 감지 및 자동 정지
      const failureCheck = db.transaction((tx) => checkConsecutiveFailures(tx, p.id))
      if (failureCheck.shouldDisable) {
        db.transaction((tx) => {
          tx.prepare('UPDATE projects SET autonomy_enabled=? WHERE id=?')
            .bind('0', p.id).run()
          logActivity(tx, {
            project_id: p.id, agent_name: 'system', action: 'autonomy_auto_disabled',
            detail: `연속 실패 차단: 최근 ${failureCheck.recentCount}개 중 ${failureCheck.failureCount}개 failed → 자동으로 autonomy_enabled='0' 설정`,
            created_at: nowIsoStr,
          })
        })
        out.locked_skip++  // 이번 주기는 스폰하지 않음
        continue
      }

      // project_cycle 용 max_turns 미리 resolve
      const maxTurns = await resolveMaxTurns(db, { project_id: p.id, task_type: 'project_cycle' })
      const { outcome, commandId } = db.transaction((tx) => spawnOneCycle(tx, p, now, maxTurns))
      if (outcome === 'spawned') {
        out.spawned++
        const dispatchPromise = dispatchApprovedCommand(db, commandId).catch((e) =>
          logActivity(db, {
            project_id: p.id, command_id: commandId, agent_name: 'system',
            action: 'instant_dispatch_error', detail: e.message, created_at: nowIsoStr,
          }))
        // engine/run.js 가 넘긴 경우에만 수집(§ 위 JSDoc) — 안 넘기면 기존과 동일한 fire-and-forget.
        if (Array.isArray(pendingDispatches)) pendingDispatches.push(dispatchPromise)
      }
      else if (outcome === 'budget') out.budget_skip++
      else out.locked_skip++
    } catch (e) {
      out.locked_skip++  // 개별 tx 실패는 다음 틱에 재시도(멱등키·due 로 안전).
      try { logActivity(db, { project_id: p.id, agent_name: 'system', action: 'cycle_spawn_error', detail: e.message, created_at: nowIsoStr }) } catch { /* 무시 */ }
    }
  }
  return out
}
