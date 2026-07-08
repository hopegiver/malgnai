/**
 * lead.js — 분산(distributed) 자율 루프 적재 라우트.
 *
 *  POST /api/lead/spawn-due     [X-API-Key]  due 프로젝트 워커 단일 스폰(원자 tx).
 *  POST /api/lead/cycle-result  [X-API-Key]  프로젝트 워커 결과 얇은 적재(summary+proposal).
 *  GET/PUT /api/lead/autonomy   [JWT]        마스터 자율 스위치(kill-switch).
 *  GET  /api/lead/status        [JWT]        자율 제어판 현황(읽기 전용).
 *
 * ⚠️ central(malgnai-lead) 경로는 제거됐다(단순 코어 전환, docs/design/simple-core.md).
 *   중앙 LEAD 오케스트레이터(/ingest, autonomous-projects, autonomy_mode 스위치)는 삭제.
 *   유일 경로 = distributed: 프로젝트별 지정 에이전트(projects.lead_agent_name)가 자기 STATUS/goal 을
 *   읽고 스스로 판단한다. 파싱은 poll(로컬), **DB 쓰기·게이트는 서버 한 곳에서만**.
 *
 * ⚠️ 실행 인프라 재설계(execution-infra-redesign.md §1.4, v3 최종): POST /api/lead/worker-result 는
 *   폐지됐다(리라이트 아님). commands.task_id 를 채우던 코드(상시 lead task 앵커·proposal INSERT)가
 *   §1.4/§1.5 로 전부 제거되어, task_id 가 채워지는 경로가 전무해졌기 때문이다. 이 경로가 하던
 *   lessons[]/next_task_suggestions[]→memories 추출은 현재 사실상 미가동이었다(설계 §1.4 트레이드오프).
 */
import { Hono } from 'hono'
import { apiKeyMiddleware, authMiddleware } from '../middleware/auth.js'
// activity_logs 단일 쓰기관문 — 정규화 포함(system→telemetry, autonomy_toggle→audit). reviewer §6.
import { logActivity } from '../lib/activity-log.js'
import { badRequest, notFound } from '../utils/response.js'
import { ingestCommandFailureTx, extractEmbeddedJson } from '../lib/worker-ingest.js'
import { ingestCycleResultTx } from '../lib/cycle-ingest.js'
import { DEFAULT_BUDGET, createBudgetGate, isTruthyFlag } from '../lib/autonomy.js'
import { periodKeyForCadence, nextRunAtIso } from '../lib/cadence.js'
import { buildProjectCyclePrompt } from '../lib/project-cycle-prompt.js'
import { AUTONOMOUS_KINDS } from '../dao/init.js'
import { dispatchApprovedCommand } from '../lib/dispatch-worker.js'

const router = new Hono()

// ── 분산 전환(설계 §2.2·§2.9): 프로젝트 워커 단일 스폰 ──────────────────────

const REAP_CUTOFF = '-20 minutes'  // SPAWN_TIMEOUT(10분)의 2배. 이보다 오래 claimed/running 이면 stale.

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
 * @returns {{outcome: 'spawned'|'locked'|'budget', commandId?: string}}
 */
function spawnOneCycle(tx, p, now) {
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
                             ai_summary, claimed_by, claimed_at)
       VALUES (?, ?, NULL, ?, 'claimed', 'allowlist', 'autoloop', ?, ?, ?, 'project_cycle', '업무', 'low', ?, 'server-spawn-due', ?)`
    ).bind(cmdId, p.id, buildProjectCyclePrompt(p, feedbacks), iso, iso, idem,
      `[자동] ${p.name} 프로젝트 자율 박동`, iso).run()
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
      project_id: p.id, agent_name: 'system', action: 'cycle_spawn',
      detail: `project_cycle 스폰: ${idem}`, created_at: iso,
    })
    return { outcome: 'spawned', commandId: cmdId }
  }
  return { outcome: 'locked' }  // 멱등 충돌(이미 이 주기 command 존재) = 재스폰 안 함.
}

/**
 * POST /api/lead/spawn-due  [X-API-Key] — 분산 전환의 원자 스폰 결정점(설계 §2.2).
 *
 * 경량 러너(run-autonomous-cycles.js)가 60s 로 호출한다. 스폰 결정 전부를 서버가 처리:
 *   1) reapStaleCycles → 2) master 게이트 → 3) due 열거 → 4) 각 프로젝트 단일 tx 스폰.
 * 응답: { master_enabled, scanned, spawned, locked_skip, budget_skip, reaped }.
 */
router.post('/spawn-due', apiKeyMiddleware, async (c) => {
  const db = c.env.DB
  const now = new Date()
  const nowIsoStr = now.toISOString()
  const out = { master_enabled: false, scanned: 0, spawned: 0, locked_skip: 0, budget_skip: 0, reaped: 0 }

  // 1) reapStaleCycles: 오래 claimed/running 인 command 전체 → failed(락 해제·장애복구).
  //    실행 인프라 재설계(§2.5, v3 최종): task_type='project_cycle' 필터를 제거해 claimed/running
  //    전체로 reap 대상을 넓혔다 — 즉시스폰된 사람 커맨드(claimed_by='server-immediate')는 이
  //    필터에 안 걸려 영원히 claimed 로 남을 수 있었다(decision d01d3834 전제 정정). 넓히기는 순수
  //    이득이고 부작용 없음(기존에도 있었던 "poll claim 후 poll 프로세스 죽음" 갭도 부수적으로 해소).
  try {
    const r = await db.prepare(
      // [reviewer MAJOR-1] updated_at 은 ISO-T('...T..Z'), datetime('now',?)는 공백형식이라
      //   원시 TEXT 비교가 'T'(0x54)>' '(0x20)로 항상 false → stale 미회수(영구 락).
      //   양쪽을 datetime()으로 정규화해 비교한다.
      `UPDATE commands SET status='failed', error='stale cycle reaped', updated_at=?
         WHERE status IN ('claimed','running')
           AND datetime(updated_at) < datetime('now', ?)`
    ).bind(nowIsoStr, REAP_CUTOFF).run()
    out.reaped = r?.meta?.changes || 0
  } catch { /* best-effort */ }

  // 2) 마스터 자율 스위치(kill-switch). OFF 면 즉시 종료(비용0).
  const autoRow = await db.prepare("SELECT value FROM app_settings WHERE key = 'autonomy_enabled'").first()
  out.master_enabled = autoRow ? isTruthyFlag(autoRow.value) : false
  if (!out.master_enabled) return c.json(out)

  // 3) due 프로젝트 열거(kind 화이트리스트 + 프로젝트 자율 ON + lead_agent_name 존재 + next_run_at due).
  let rows = []
  try {
    const kindPlaceholders = AUTONOMOUS_KINDS.map(() => '?').join(',')
    rows = (await db.prepare(
      `SELECT id, name, goal, kpi_json, lead_agent_name, cadence, next_run_at
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
  for (const p of rows) {
    try {
      const { outcome, commandId } = db.transaction((tx) => spawnOneCycle(tx, p, now))
      if (outcome === 'spawned') {
        out.spawned++
        dispatchApprovedCommand(db, commandId).catch((e) =>
          logActivity(db, {
            project_id: p.id, agent_name: 'system',
            action: 'instant_dispatch_error', detail: e.message, created_at: nowIsoStr,
          }))
      }
      else if (outcome === 'budget') out.budget_skip++
      else out.locked_skip++
    } catch (e) {
      out.locked_skip++  // 개별 tx 실패는 다음 틱에 재시도(멱등키·due 로 안전).
      try { logActivity(db, { project_id: p.id, agent_name: 'system', action: 'cycle_spawn_error', detail: e.message, created_at: nowIsoStr }) } catch { /* 무시 */ }
    }
  }
  return c.json(out)
})

// project_cycle 파싱 실패 기록(§2.9-3) — ISSUE memory + 감사. command 상태는 poll 이 이미 처리.
async function recordCycleParseFailure(c, command, errorCode, rawStdout) {
  const db = c.env.DB
  try {
    db.transaction((tx) => {
      const now = new Date().toISOString()
      tx.prepare(
        `INSERT INTO memories (id, project_id, memory_type, title, content, importance, agent_name, created_at)
         VALUES (?, ?, 'ISSUE', ?, ?, 4, 'system', ?)`
      ).bind(crypto.randomUUID(), command.project_id,
        '프로젝트 사이클 출력 파싱 실패', `errorCode=${errorCode}${rawStdout ? '\n' + String(rawStdout).slice(0, 2000) : ''}`, now).run()
      logActivity(tx, { project_id: command.project_id, agent_name: 'system', action: 'cycle_parse_fail', detail: `errorCode=${errorCode}`, created_at: now })
    })
  } catch { /* 실패 기록 자체 실패는 치명 아님 */ }
}

/**
 * POST /api/lead/cycle-result  [X-API-Key] — 프로젝트 워커 결과 얇은 적재(설계 §2.9).
 * body: { command_id, cycle_json?, stdout? }
 * 응답: 200 { report } | 400/404/422/500
 */
router.post('/cycle-result', apiKeyMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const commandId = body.command_id
  if (!commandId || typeof commandId !== 'string') return badRequest(c, 'command_id is required')

  const db = c.env.DB
  const command = await db.prepare('SELECT * FROM commands WHERE id = ?').bind(commandId).first()
  if (!command) return notFound(c, 'command not found')
  if (command.task_type !== 'project_cycle') return badRequest(c, 'command is not a project_cycle')

  const source = body.cycle_json !== undefined ? body.cycle_json : body.stdout
  const extracted = extractEmbeddedJson(source)
  if (!extracted.ok) {
    await recordCycleParseFailure(c, command, extracted.error, body.stdout)
    return c.json({ error: 'CYCLE_JSON_PARSE_FAILED', reason: extracted.error }, 422)
  }

  let report
  try {
    report = db.transaction((tx) => ingestCycleResultTx(tx, command, extracted.value))
  } catch (e) {
    return c.json({ error: 'INGEST_FAILED', reason: e.message }, 500)
  }
  return c.json({ report })
})

/**
 * POST /api/lead/command-failed  [X-API-Key]
 * body: { command_id, error? }
 *
 * claude 프로세스가 비정상 종료(exit_code≠0)했을 때 poll-commands.js 가 호출하는 실패 전용 적재.
 * cycle-result(project_cycle 전용, §1.4 v3 최종으로 worker-result 는 폐지)는 exit 0(=CYCLE JSON 이
 * 나올 여지가 있을 때)만 호출되므로,
 * 실행 자체가 실패한 경우는 이 경로로만 activity_log 기록 + (있다면) task 종료 처리가 이뤄진다.
 * command 행 자체의 status='failed' PATCH 는 poll 이 /api/commands 로 이미 반영한 뒤 호출한다.
 */
router.post('/command-failed', apiKeyMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const commandId = body.command_id
  if (!commandId || typeof commandId !== 'string') return badRequest(c, 'command_id is required')

  const db = c.env.DB
  const command = await db.prepare('SELECT * FROM commands WHERE id = ?').bind(commandId).first()
  if (!command) return notFound(c, 'command not found')

  let report
  try {
    report = db.transaction((tx) => ingestCommandFailureTx(tx, command, body.error || null))
  } catch (e) {
    return c.json({ error: 'INGEST_FAILED', reason: e.message }, 500)
  }
  return c.json({ report })
})

/**
 * R-2 마스터 자율 스위치 / kill-switch (1급화) — 전면 즉시정지·재개를 단일 스위치로.
 *
 *  GET  /api/lead/autonomy  [JWT]  현재 자율 상태 조회.
 *  PUT  /api/lead/autonomy  [JWT]  body:{ enabled:boolean } — ON/OFF 토글(=kill-switch).
 *
 * 저장소: app_settings.autonomy_enabled('1'|'0'). 기본 OFF('0')=R0(LEAD auto 자식 전부 승인대기).
 * OFF 로 두면 박동/규칙/큐를 건드리지 않아도 즉시 모든 auto 배정이 멈춘다(ingest 게이트가 강등).
 * 운영자 액션이므로 JWT 필수(X-API-Key 자동화 경로로는 못 켠다).
 */
const AUTONOMY_KEY = 'autonomy_enabled'

router.get('/autonomy', authMiddleware, async (c) => {
  const db = c.env.DB
  const row = await db.prepare('SELECT value, updated_at FROM app_settings WHERE key = ?')
    .bind(AUTONOMY_KEY).first()
  const enabled = row ? (row.value === '1' || row.value === 'true' || row.value === 'on') : false
  return c.json({ enabled, raw: row?.value ?? null, updated_at: row?.updated_at ?? null })
})

router.put('/autonomy', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.enabled !== 'boolean') return badRequest(c, 'enabled (boolean) is required')
  const db = c.env.DB
  const now = new Date().toISOString()
  const value = body.enabled ? '1' : '0'
  // upsert(비파괴): 행이 없으면 생성, 있으면 값만 갱신.
  await db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(AUTONOMY_KEY, value, now).run()
  // 감사로그(누가 자율을 켜고 껐는지 — kill-switch 작동 이력). 단일 관문 — autonomy_toggle 은
  //   normalizeLevel 이 level=audit 로 분류(사람이 알아야 할 설정변경). project_id 없음(전역 설정).
  try {
    logActivity(db, {
      agent_name: c.get('user')?.sub || 'web', action: 'autonomy_toggle',
      detail: `autonomy_enabled=${value} (${body.enabled ? 'ON=R1' : 'OFF=R0/kill-switch'})`,
      created_at: now,
    })
  } catch { /* 감사 실패는 본 동작을 막지 않음 */ }
  return c.json({ enabled: body.enabled, updated_at: now })
})

/**
 * GET /api/lead/status  [JWT] — 자율 제어판 현황(읽기 전용, 조회만).
 *
 * 반환:
 *  - autonomy: { enabled, updated_at }                  마스터 스위치 상태(kill-switch)
 *  - cost:     { today_usd, daily_limit_usd, pct }      오늘 자율 비용 vs 하루 예산 한도
 *  - workers:  { running }                              실행 중 워커(claimed/running command 수)
 *  - last_cycle: { status, created_at, cost_usd, error, ... } | null   최근 자율 사이클 요약
 *  - approvals: { pending }                             승인 대기 중인 LEAD 생성 태스크(승인대기함) 수
 *
 * 원칙: 자율 엔진 로직(게이트/규칙/큐)은 건드리지 않고, 기존 집계만 읽는다.
 *
 * ⚠️ 실행 인프라 재설계(§1.4 RV-3, v3 최종): 구 구현은 commands.task_id → tasks(task_type='lead_cycle')
 *   JOIN 으로 집계했으나, 상시 lead task 앵커 제거(§1.4)로 task_id 를 채우는 코드가 전무해져 이 JOIN
 *   조건은 영원히 0건이 된다(배포 직후 비용$0·워커0 고정 표시 회귀). project_id IN (자율대상 프로젝트)
 *   기준으로 재작성한다 — 이 스코프는 §1.4 의 실제 예산 게이트(todayCostUsd(tx,projectId))와 정확히
 *   같아, 대시보드 표시와 실제 게이트 집행이 처음으로 1:1 일치한다(부수적 버그 수정).
 */
router.get('/status', authMiddleware, async (c) => {
  const db = c.env.DB
  const one = async (sql, ...args) => (await db.prepare(sql).bind(...args).first()) || {}

  // 1) 자율 스위치.
  const autoRow = await db.prepare('SELECT value, updated_at FROM app_settings WHERE key = ?')
    .bind(AUTONOMY_KEY).first()
  const autonomyEnabled = autoRow
    ? (autoRow.value === '1' || autoRow.value === 'true' || autoRow.value === 'on')
    : false

  // 2) 일일 비용 한도(단순 코어 최소안전 3종 중 1개). 전역 기본값(DEFAULT_BUDGET) 사용.
  const dailyLimit = Number(DEFAULT_BUDGET.daily_cost_limit_usd)

  // 3) 오늘 자율 비용 = 자율대상 프로젝트(autonomy_enabled='1') 전체 command 의 오늘 SUM(cost_usd).
  const costRow = await one(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM commands
      WHERE project_id IN (SELECT id FROM projects WHERE autonomy_enabled = '1')
        AND date(created_at,'localtime') = date('now','localtime')`
  )
  const todayCost = Number(costRow.total) || 0
  const costPct = dailyLimit > 0 ? Math.min(100, Math.round((todayCost / dailyLimit) * 100)) : 0

  // 4) 실행 중 워커 = 자율대상 프로젝트의 claimed/running command.
  const workerRow = await one(
    `SELECT COUNT(*) AS running FROM commands
      WHERE project_id IN (SELECT id FROM projects WHERE autonomy_enabled = '1')
        AND status IN ('claimed','running')`
  )

  // 5) 최근 자율 사이클 — 가장 최신 project_cycle command(분산 스폰 단위). tasks JOIN 없었으므로 무변경.
  const lastCycle = await db.prepare(
    `SELECT c.id, c.status, c.cost_usd, c.error, c.exit_code, c.created_at, c.updated_at
       FROM commands c
      WHERE c.task_type = 'project_cycle'
      ORDER BY c.created_at DESC LIMIT 1`
  ).first()

  // 6) 승인 대기 중인 커맨드 수 = 자율대상 프로젝트의 승인대기함(queued + review 미처리).
  //    단, project_cycle 스폰 command 는 워커 실행 대기(poll 이 곧 claim)이지 '승인 대기'가 아니므로
  //    제외한다. 승인 대상은 사람 커맨드/워커 proposal 뿐(task_type != 'project_cycle').
  const apprRow = await one(
    `SELECT COUNT(*) AS pending FROM commands
      WHERE project_id IN (SELECT id FROM projects WHERE autonomy_enabled = '1')
        AND status = 'queued' AND review_status IS NULL AND task_type != 'project_cycle'`
  )

  // 7) 프로젝트별 자율 상태 목록
  let projectRows = []
  try {
    projectRows = (await db.prepare(`
      SELECT p.id, p.name, p.status, p.autonomy_enabled, p.cadence,
             p.next_run_at, p.last_run_at,
             (SELECT COUNT(*) FROM commands c
              WHERE c.project_id = p.id
              AND c.status = 'queued'
              AND c.review_status IS NULL
              AND c.task_type != 'project_cycle') as pending_approvals
      FROM projects p
      WHERE p.status != 'archived'
      ORDER BY p.autonomy_enabled DESC, p.name ASC
      LIMIT 20
    `).all()).results || []
  } catch { projectRows = [] }

  return c.json({
    autonomy: { enabled: autonomyEnabled, updated_at: autoRow?.updated_at ?? null },
    cost: { today_usd: todayCost, daily_limit_usd: dailyLimit, pct: costPct },
    workers: { running: workerRow.running || 0 },
    last_cycle: lastCycle || null,
    approvals: { pending: apprRow.pending || 0 },
    projects: projectRows,
  })
})

export default router
