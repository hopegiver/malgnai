/**
 * lead.js — 분산(distributed) 자율 루프 적재 라우트.
 *
 *  GET  /api/lead/autonomy      [JWT]              마스터 자율 스위치(kill-switch) 조회.
 *  PUT  /api/lead/autonomy      [JWT,super_admin]  마스터 자율 스위치 토글. 2026-07-14 super_admin 가드 신설(구멍 수정).
 *  GET  /api/lead/status        [JWT]        자율 제어판 현황(읽기 전용). 현행 유지.
 *  GET  /api/lead/engine-settings [JWT]       engine.* 설정(§4.2 이관 5키+tick_enabled) 조회. 2026-07-12 신설.
 *  PUT  /api/lead/engine-settings [JWT,super_admin] engine.* 설정 1건 수정(화이트리스트 밖 키는 400). 2026-07-12 신설.
 *  GET  /api/lead/app-settings    [JWT]       app_settings 범용 조회(autonomy_enabled/engine.* 제외). 2026-07-13 신설.
 *  PUT  /api/lead/app-settings    [JWT,super_admin] app_settings 임의 키 upsert(예약 키는 400). 2026-07-13 신설.
 *  DELETE /api/lead/app-settings/:key [JWT,super_admin] app_settings 키 삭제(예약 키는 400). 2026-07-13 신설.
 *
 * ⚠️ central 경로는 제거됐다(단순 코어 전환, docs/design/simple-core.md).
 *   중앙 LEAD 오케스트레이터(/ingest, autonomous-projects, autonomy_mode 스위치)는 삭제.
 *
 * ⚠️ 엔진↔웹앱 분리 Phase 3 완결(2026-07-12 컷오버 → 2026-07-13 물리삭제, docs/design/
 *   engine-webapp-separation.md §5): 자율 루프의 실 실행 경로는 `com.malgnai.engine`
 *   (engine/run.js, HTTP 미사용·DB 직접 호출)으로 완전히 옮겨갔다. 예전 `POST /spawn-due`·
 *   `/cycle-result`·`/command-failed` 3개 라우트(`bin/loop.js`+`bin/lib/poll-commands.js`가
 *   HTTP 로 호출하던 것, 그 LaunchAgent는 이미 bootout+plist 아카이브됨)는 410 Gone 으로
 *   낮춰 소킹한 결과 유일한 호출자가 `test/routes/lead.test.js`(자체 검증용) 뿐임을 로그로
 *   확인 후 핸들러·주석·테스트를 전부 물리 삭제했다.
 *
 * ⚠️ 실행 인프라 재설계(execution-infra-redesign.md §1.4, v3 최종): POST /api/lead/worker-result 는
 *   폐지됐다(리라이트 아님). commands.task_id 를 채우던 코드(상시 lead task 앵커·proposal INSERT)가
 *   §1.4/§1.5 로 전부 제거되어, task_id 가 채워지는 경로가 전무해졌기 때문이다. 이 경로가 하던
 *   lessons[]/next_task_suggestions[]→memories 추출은 현재 사실상 미가동이었다(설계 §1.4 트레이드오프).
 */
import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import { badRequest, forbidden } from '../utils/response.js'
import { DEFAULT_BUDGET } from '../lib/autonomy.js'
import { logActivity } from '../lib/activity-log.js'
import { isSuperAdmin } from '../lib/roles.js'

const router = new Hono()

// 최고관리자(role='super_admin') 전용 가드 — 마스터 킬스위치·엔진 설정·앱 설정은 super_admin만.
async function requireSuperAdmin(c, next) {
  const me = c.get('user')
  if (!me || !isSuperAdmin(me.role)) return forbidden(c, '최고관리자 권한이 필요합니다.')
  await next()
}

// ── 엔진 설정 화이트리스트(engine-webapp-separation.md §4.2 이관 대상 5개 키 + tick_enabled) ──
// 이 목록에 있는 키만 GET/PUT /engine-settings 로 조회·수정 가능(임의 app_settings 키 조작 방지).
// 값은 전부 문자열로 저장(app_settings 스키마 원칙), type 은 UI 렌더링/검증용 힌트일 뿐이다.
const ENGINE_SETTINGS = [
  { key: 'engine.tick_enabled', label: '엔진 틱 활성화', type: 'bool', default: '1',
    description: 'com.malgnai.engine 프로세스가 매 틱 실제로 동작할지 여부(0이면 즉시 종료만 함).' },
  { key: 'engine.daily_cost_limit_usd', label: '일일 비용 상한(USD)', type: 'number', default: '100',
    description: '자율 배정 전체의 하루 누적 비용 상한. 초과 시 auto→approve 강등(최소안전 3종 중 1개).' },
  { key: 'engine.reap_cutoff_minutes', label: 'Reap 컷오프(분)', type: 'number', default: '30',
    description: 'claimed/running 상태로 이 시간 이상 멈춰 있으면 stale 로 간주해 회수.' },
  { key: 'engine.consecutive_failure_threshold', label: '연속 실패 임계값', type: 'number', default: '10',
    description: '최근 사이클 중 연속 실패 건수가 이 값 이상이면 자율 배정을 중단.' },
  { key: 'engine.recent_cycles_count', label: '최근 사이클 관찰 개수', type: 'number', default: '15',
    description: '연속 실패 판정에 사용할 최근 사이클 표본 개수.' },
  { key: 'engine.max_turns_default', label: 'project_cycle 기본 max_turns', type: 'number', default: '8',
    description: '에이전트별 budget 미설정 시 project_cycle 워커의 기본 최대 턴 수.' },
]
const ENGINE_SETTINGS_MAP = new Map(ENGINE_SETTINGS.map(s => [s.key, s]))

// ── 프로젝트 자율 상태 판별(projects.js isProjectAutonomyOn과 동일 기준) ──
// autonomy_enabled='1' && cadence!='off' && lead_agent_name 존재 → effective ON
function isProjectAutonomyOn(p) {
  if (!p) return false
  const flag = p.autonomy_enabled
  const on = flag === '1' || flag === 'true' || flag === 'on' || flag === 1 || flag === true
  if (!on) return false
  if (p.cadence && String(p.cadence).toLowerCase() === 'off') return false
  if (!p.lead_agent_name) return false
  return true
}

/**
 * R-2 마스터 자율 스위치 / kill-switch (1급화) — 전면 즉시정지·재개를 단일 스위치로.
 *
 *  GET  /api/lead/autonomy  [JWT]  현재 자율 상태 조회.
 *  PUT  /api/lead/autonomy  [JWT]  body:{ enabled:boolean } — ON/OFF 토글(=kill-switch).
 *
 * 저장소: app_settings.autonomy_enabled('1'|'0'). 기본 OFF('0')=R0(LEAD auto 자식 전부 승인대기).
 * OFF 로 두면 박동/규칙/큐를 건드리지 않아도 즉시 모든 auto 배정이 멈춘다(ingest 게이트가 강등).
 * 운영자 액션이므로 JWT 필수(X-API-Key 자동화 경로로는 못 켠다).
 *
 * ⚠️ (2026-07-14 3단계 role 확장) PUT 은 최고관리자(super_admin) 전용으로 강화됐다 — 이전엔
 *   requireAdmin 류 가드가 전혀 없어 **로그인만 하면 아무 사용자나** 전역 자율운영을 켜고 끌 수
 *   있는 구멍이었다(GET 은 현황 조회라 그대로 authMiddleware 만 유지).
 */
const AUTONOMY_KEY = 'autonomy_enabled'

router.get('/autonomy', authMiddleware, async (c) => {
  const db = c.env.DB
  const row = await db.prepare('SELECT value, updated_at FROM app_settings WHERE key = ?')
    .bind(AUTONOMY_KEY).first()
  const enabled = row ? (row.value === '1' || row.value === 'true' || row.value === 'on') : false
  return c.json({ enabled, raw: row?.value ?? null, updated_at: row?.updated_at ?? null })
})

router.put('/autonomy', authMiddleware, requireSuperAdmin, async (c) => {
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
 *  - projects: [ { ...기존 필드, cost_today_usd, cycles_total, cycles_failed, last_cycle_status } ]
 *      2026-07-13 신설(하위호환 유지, 필드 추가만) — 프로젝트별 실측:
 *        cost_today_usd    오늘(localtime) 해당 프로젝트 commands.cost_usd 합계
 *        cycles_total      최근 7일 task_type='project_cycle' 커맨드 표본수
 *        cycles_failed     그중 status IN ('failed','rejected','expired') 건수(실패율은 failed/total로 프론트 계산)
 *        last_cycle_status 그 프로젝트의 가장 최근 project_cycle 커맨드 status
 *      autonomy_enabled != '1' 인 프로젝트는 자율로 돌지 않으므로 네 필드 모두 null(불필요한 서브쿼리 스킵).
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
  // (2026-07-14 Critical H-3 수정) 이 라우트는 이미 authMiddleware가 있어 인증은 됐지만 소유권
  //   WHERE가 전혀 없어 아래 모든 집계·projects 배열이 로그인한 모든 사용자에게 전체 노출됐다
  //   (/autonomy 화면이 실제로 호출하는 엔드포인트). "화면마다 자기 프로젝트만" 원칙에 맞춰
  //   집계(costRow/workerRow/apprRow)와 projectRows 전부 owner/collaborator 기준으로 좁힌다.
  //   AUTONOMY_KEY(마스터 킬스위치)는 전역 설정이라 그대로 둔다.
  // (2026-07-14 3단계 role 확장 후속 수정) super_admin은 모니터링 목적으로 이 소유권 스코프를
  //   전부 건너뛴다(projects.js/commands.js 와 동일한 super_admin bypass 원칙, getMonitorableProject
  //   와 동형 — 읽기 전용 라우트라 문제 없음). OWNED를 '1=1'로 무조건참 처리하고 그에 맞춰
  //   bind 인자도 0개로 줄인다(placeholder 수가 실제 바인딩 값 수와 항상 일치해야 하므로).
  const me = c.get('user')
  const user = me?.sub
  const superAdmin = isSuperAdmin(me?.role)
  const OWNED = superAdmin
    ? '1=1'
    : '(owner_user_id = ? OR id IN (SELECT project_id FROM project_collaborators WHERE user = ?))'
  const ownedArgs = superAdmin ? [] : [user, user]

  // 1) 자율 스위치.
  const autoRow = await db.prepare('SELECT value, updated_at FROM app_settings WHERE key = ?')
    .bind(AUTONOMY_KEY).first()
  const autonomyEnabled = autoRow
    ? (autoRow.value === '1' || autoRow.value === 'true' || autoRow.value === 'on')
    : false

  // 2) 일일 비용 한도(단순 코어 최소안전 3종 중 1개).
  //   엔진↔웹앱 분리(engine-webapp-separation.md §4.2)로 이 값의 정본은 이미
  //   app_settings.engine.daily_cost_limit_usd 로 이관되어 있다(Phase 0, 기본값 100).
  //   구현은 DEFAULT_BUDGET.daily_cost_limit_usd(autonomy.js, DEV MODE 로 Infinity 하드코드)만
  //   읽고 있어 대시보드가 실제 설정값(100)이 아닌 fallback(1000)을 보여주는 표시 버그였다.
  //   DB 값을 우선하고, 행이 없을 때만 DEFAULT_BUDGET 으로 안전 폴백한다.
  const engineLimitRow = await db.prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind('engine.daily_cost_limit_usd').first()
  const dailyLimit = engineLimitRow ? Number(engineLimitRow.value) : Number(DEFAULT_BUDGET.daily_cost_limit_usd)

  // 3) 오늘 자율 비용 = 자율대상 프로젝트(autonomy_enabled='1') 중 내 소유/공유 프로젝트 command 의
  //    오늘 SUM(cost_usd). (H-3) 소유권 무관 시스템 전체 합계였던 것을 사용자 스코프로 좁힘.
  const costRow = await one(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM commands
      WHERE project_id IN (SELECT id FROM projects WHERE autonomy_enabled = '1' AND ${OWNED})
        AND date(created_at,'localtime') = date('now','localtime')`,
    ...ownedArgs,
  )
  const todayCost = Number(costRow.total) || 0
  const costPct = dailyLimit > 0 ? Math.min(100, Math.round((todayCost / dailyLimit) * 100)) : 0

  // 4) 실행 중 워커 = 자율대상 프로젝트 중 내 소유/공유 프로젝트의 claimed/running command.
  const workerRow = await one(
    `SELECT COUNT(*) AS running FROM commands
      WHERE project_id IN (SELECT id FROM projects WHERE autonomy_enabled = '1' AND ${OWNED})
        AND status IN ('claimed','running')`,
    ...ownedArgs,
  )

  // 5) 최근 자율 사이클 — 가장 최신 project_cycle command(분산 스폰 단위). (H-3 연장) COO 지시에
  //    명시되진 않았으나 동일 정보노출 성격(다른 사용자 프로젝트의 사이클 id/비용/에러가 그대로
  //    보임)이라 취지에 맞춰 함께 스코프한다 — 일관성 없이 이 하나만 열어두는 게 더 이상해서.
  const lastCycle = await db.prepare(
    `SELECT c.id, c.status, c.cost_usd, c.error, c.exit_code, c.created_at, c.updated_at
       FROM commands c
      WHERE c.task_type = 'project_cycle'
        AND c.project_id IN (SELECT id FROM projects WHERE ${OWNED})
      ORDER BY c.created_at DESC LIMIT 1`
  ).bind(...ownedArgs).first()

  // 6) 승인 대기 중인 커맨드 수 = 자율대상 프로젝트 중 내 소유/공유 프로젝트의 승인대기함
  //    (queued + review 미처리). project_cycle 스폰 command 는 워커 실행 대기(poll 이 곧 claim)이지
  //    '승인 대기'가 아니므로 제외한다. 승인 대상은 사람 커맨드/워커 proposal 뿐(task_type != 'project_cycle').
  const apprRow = await one(
    `SELECT COUNT(*) AS pending FROM commands
      WHERE project_id IN (SELECT id FROM projects WHERE autonomy_enabled = '1' AND ${OWNED})
        AND status = 'queued' AND review_status IS NULL AND task_type != 'project_cycle'`,
    ...ownedArgs,
  )

  // 7) 프로젝트별 자율 상태 목록 — 자율 ON(= isProjectAutonomyOn 기준)인 프로젝트만.
  //   2026-07-14: 자율 켜기/끄기는 프로젝트 상세에서 이미 충분히 가능하므로(대표 결정),
  //   이 관찰 대시보드는 OFF 프로젝트를 아예 노출하지 않는다 — 목록 = 항상 ON이라 비용/실패율
  //   서브쿼리를 CASE WHEN 으로 감쌀 필요도 없어짐.
  let projectRows = []
  try {
    projectRows = (await db.prepare(`
      SELECT p.id, p.name, p.status, p.autonomy_enabled, p.cadence, p.lead_agent_name,
             p.next_run_at, p.last_run_at,
             (SELECT COUNT(*) FROM commands c
              WHERE c.project_id = p.id
              AND c.status = 'queued'
              AND c.review_status IS NULL
              AND c.task_type != 'project_cycle') as pending_approvals,
             (SELECT COALESCE(SUM(c.cost_usd), 0) FROM commands c
              WHERE c.project_id = p.id
              AND date(c.created_at,'localtime') = date('now','localtime')) as cost_today_usd,
             (SELECT COUNT(*) FROM commands c
              WHERE c.project_id = p.id
              AND c.task_type = 'project_cycle'
              AND c.created_at >= datetime('now', '-7 days')) as cycles_total,
             (SELECT COUNT(*) FROM commands c
              WHERE c.project_id = p.id
              AND c.task_type = 'project_cycle'
              AND c.created_at >= datetime('now', '-7 days')
              AND c.status IN ('failed', 'rejected', 'expired')) as cycles_failed,
             (SELECT c.status FROM commands c
              WHERE c.project_id = p.id
              AND c.task_type = 'project_cycle'
              ORDER BY c.created_at DESC LIMIT 1) as last_cycle_status
      FROM projects p
      WHERE p.status != 'archived'
        AND p.autonomy_enabled = '1'
        AND (p.cadence IS NULL OR p.cadence != 'off')
        AND p.lead_agent_name IS NOT NULL AND p.lead_agent_name != ''
        AND ${superAdmin ? '1=1' : '(p.owner_user_id = ? OR p.id IN (SELECT project_id FROM project_collaborators WHERE user = ?))'}
      ORDER BY p.name ASC
      LIMIT 20
    `).bind(...ownedArgs).all()).results || []
  } catch { projectRows = [] }

  return c.json({
    autonomy: { enabled: autonomyEnabled, updated_at: autoRow?.updated_at ?? null },
    cost: { today_usd: todayCost, daily_limit_usd: isFinite(dailyLimit) ? dailyLimit : 1000, pct: costPct },
    workers: { running: workerRow.running || 0 },
    last_cycle: lastCycle || null,
    approvals: { pending: apprRow.pending || 0 },
    projects: projectRows.map(p => ({ ...p, autonomy_active: isProjectAutonomyOn(p) })),
  })
})

/**
 * GET /api/lead/engine-settings  [JWT]  — engine.* 설정 화이트리스트 현재값 조회(읽기 전용).
 *
 * 엔진↔웹앱 분리(engine-webapp-separation.md §4.2/§7-5): "설정은 디비에 세팅"이 목표이고,
 * §4.2 이관 대상 키는 전부 app_settings 로 옮겨져 있지만 지금까지 편집 수단은 sqlite CLI
 * 뿐이었다(문서가 "당장은 CLI 로 충분"이라 명시한 Phase 4 후보). 이 라우트는 그 갭을 메워
 * 대표가 웹 UI(/autonomy)에서 직접 값을 보고 바꿀 수 있게 한다.
 *
 * 행이 아직 없는 키는(부팅 시드 전이거나 옛 라이브 DB) 정의된 default 로 채워 반환한다
 * (get 시점에 INSERT 하지 않음 — 순수 조회, PUT 시에만 upsert).
 */
router.get('/engine-settings', authMiddleware, async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare(
    `SELECT key, value, updated_at FROM app_settings WHERE key LIKE 'engine.%'`
  ).all()).results || []
  const byKey = new Map(rows.map(r => [r.key, r]))
  const settings = ENGINE_SETTINGS.map(def => {
    const row = byKey.get(def.key)
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      type: def.type,
      default: def.default,
      value: row ? row.value : def.default,
      updated_at: row?.updated_at ?? null,
    }
  })
  return c.json({ settings })
})

/**
 * PUT /api/lead/engine-settings  [JWT, admin]  — engine.* 설정 화이트리스트 1건 수정.
 * body: { key: string, value: string|number }
 *
 * 최고관리자 전용(system.js requireSuperAdmin 과 동일 패턴) — 엔진 튜닝값은 자율 실행에 직접 영향을 주므로
 * 일반 user 롤에게는 열어주지 않는다. 화이트리스트 밖 키는 400(임의 app_settings 오염 방지).
 */
router.put('/engine-settings', authMiddleware, requireSuperAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { key, value } = body
  const def = ENGINE_SETTINGS_MAP.get(key)
  if (!def) return badRequest(c, `알 수 없는 설정 키입니다: ${key}`)
  if (value === undefined || value === null || value === '') return badRequest(c, 'value가 필요합니다')
  const strValue = String(value)
  if (def.type === 'number' && !Number.isFinite(Number(strValue))) {
    return badRequest(c, `${key}는 숫자여야 합니다`)
  }
  if (def.type === 'bool' && !['0', '1'].includes(strValue)) {
    return badRequest(c, `${key}는 '0' 또는 '1'이어야 합니다`)
  }
  const db = c.env.DB
  const now = new Date().toISOString()
  // upsert(비파괴): 행이 없으면 생성, 있으면 값만 갱신.
  await db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, strValue, now).run()
  // 감사로그 — 엔진 튜닝값은 자율 실행에 영향을 주므로 누가 언제 바꿨는지 남긴다.
  try {
    logActivity(db, {
      agent_name: c.get('user')?.sub || 'web', action: 'engine_setting_update',
      detail: `${key} = ${strValue}`,
      created_at: now,
    })
  } catch { /* 감사 실패는 본 동작을 막지 않음 */ }
  return c.json({ key, value: strValue, updated_at: now })
})

// ── app_settings 범용 CRUD 예약 키 판별 ──
// autonomy_enabled 는 /autonomy(kill-switch), engine.* 는 /engine-settings(타입검증 포함)로
// 각각 전용 라우트가 이미 관리한다. 여기서 같은 키를 무검증으로 덮어쓰게 허용하면 두 화면이
// 서로 다른 검증 규칙으로 같은 값을 경합 수정하는 이중 수정 경로가 생기므로 명시적으로 막는다.
function isReservedSettingKey(key) {
  return key === AUTONOMY_KEY || key.startsWith('engine.')
}

/**
 * GET /api/lead/app-settings  [JWT]  — app_settings 범용 조회(읽기 전용).
 *
 * autonomy_enabled(/autonomy)·engine.*(/engine-settings)는 이미 전용 화면/라우트가 있으므로
 * 이 범용 라우트에서는 그 둘을 제외한 나머지 키(예: autonomy_mode, internal_ops_autonomy_pinned
 * 같은 죽은/잔존 키나 앞으로 생길 임의의 새 키)만 반환한다.
 */
router.get('/app-settings', authMiddleware, async (c) => {
  const db = c.env.DB
  const rows = (await db.prepare(
    `SELECT key, value, updated_at FROM app_settings
      WHERE key != ? AND key NOT LIKE 'engine.%'
      ORDER BY key ASC`
  ).bind(AUTONOMY_KEY).all()).results || []
  return c.json({ settings: rows })
})

/**
 * PUT /api/lead/app-settings  [JWT, admin]  — app_settings 임의 키 upsert.
 * body: { key: string, value: string }
 *
 * autonomy_enabled/engine.* 는 예약 키라 거부(각자 전용 라우트로 유도). 그 외 키는 자유 텍스트라
 * engine-settings 와 달리 타입 검증 없이 그대로 저장한다(value='' 도 허용).
 */
router.put('/app-settings', authMiddleware, requireSuperAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { key, value } = body
  if (typeof key !== 'string' || key.trim() === '') return badRequest(c, 'key가 필요합니다')
  if (isReservedSettingKey(key)) {
    return badRequest(c, '이 키는 자율 제어판(/autonomy)에서 관리합니다')
  }
  if (value === undefined || value === null) return badRequest(c, 'value가 필요합니다')
  const strValue = String(value)
  const db = c.env.DB
  const now = new Date().toISOString()
  // upsert(비파괴): 행이 없으면 생성, 있으면 값만 갱신.
  await db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, strValue, now).run()
  try {
    logActivity(db, {
      agent_name: c.get('user')?.sub || 'web', action: 'app_setting_update',
      detail: `${key} = ${strValue}`,
      created_at: now,
    })
  } catch { /* 감사 실패는 본 동작을 막지 않음 */ }
  return c.json({ key, value: strValue, updated_at: now })
})

/**
 * DELETE /api/lead/app-settings/:key  [JWT, admin]  — app_settings 키 삭제.
 *
 * autonomy_enabled/engine.* 는 예약 키라 거부. 존재하지 않는 키는 404.
 */
router.delete('/app-settings/:key', authMiddleware, requireSuperAdmin, async (c) => {
  const key = c.req.param('key')
  if (isReservedSettingKey(key)) {
    return badRequest(c, '이 키는 자율 제어판(/autonomy)에서 관리합니다')
  }
  const db = c.env.DB
  const existing = await db.prepare('SELECT key FROM app_settings WHERE key = ?').bind(key).first()
  if (!existing) return c.json({ error: `설정 키를 찾을 수 없습니다: ${key}` }, 404)
  await db.prepare('DELETE FROM app_settings WHERE key = ?').bind(key).run()
  const now = new Date().toISOString()
  try {
    logActivity(db, {
      agent_name: c.get('user')?.sub || 'web', action: 'app_setting_delete',
      detail: key,
      created_at: now,
    })
  } catch { /* 감사 실패는 본 동작을 막지 않음 */ }
  return c.json({ deleted: true, key })
})

export default router
