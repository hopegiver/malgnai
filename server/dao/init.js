import UsersDao from './users.js'
import { hashPassword } from '../utils/password.js'
import { computeSchemaVersion } from '../lib/schema-version.js'

let initialized = false

// 대표(관리자) 계정의 로그인 ID. 과거 'admin' → 이메일 ID 로 전환(2026-06-30).
// users 비었을 때 시드 username, 그리고 기존 'admin' 행 1회 rename 대상.
export const ADMIN_USERNAME = 'hopegiver@malgnsoft.com'

// ── P0(재설계, 블로커 B4): 자율 대상 프로젝트 유형 화이트리스트 ──
// 유형 5종. spawn-due(distributed 스폰)가 이 집합의 유형만 due 열거 대상으로 삼는다.
//   단일 소스 — lead.js spawn-due 쿼리가 이 배열을 import 해 IN(...) 을 조립한다.
export const AUTONOMOUS_KINDS = ['dev', 'research', 'marketing', 'proposal', 'internal_ops']

// ── 스키마 DDL 은 여기서 관리하지 않는다 ──
// 테이블/인덱스 정본은 루트 schema.sql, 변경은 migrations/*.sql + `pnpm run db:migrate` 한 곳뿐이다.
// 부팅은 verifySchema(아래)로 버전만 대조하고 스키마를 만들지 않는다(좀비 MCP 부활 사고 43110872 근본차단).

// ── 부트스트랩 시드: 마스터 자율 스위치(kill-switch) ──
// 멱등(있으면 no-op). 비파괴 — 기존 행을 DROP/덮어쓰지 않고, 없을 때만 INSERT/보강.
// ⚠️ central 시드(내부운영 프로젝트·전용 에이전트·autonomy_mode 스위치)는
//   단순 코어 전환(docs/design/simple-core.md)으로 제거됨. distributed 는 사용자 생성 프로젝트의
//   지정 에이전트(projects.lead_agent_name)로 동작하므로 별도 LEAD 시드가 필요 없다.
// P3(2026-07-03): 실행 규칙 엔진(execution_rules) 자체를 제거 — SEED_RULES/seedExecutionRules 및
//   lead_cycle/implement/apply_diff 규칙 시드도 함께 제거됨(단순 코어 최소안전 3종에 규칙엔진 없음).

async function seedLeadLoop(db) {
  const now = new Date().toISOString()

  // (d) R-2 마스터 자율 스위치 — app_settings.autonomy_enabled 를 **기본 OFF('0')** 로 시드.
  //     없을 때만 INSERT(있으면 운영자가 켠 값을 절대 덮지 않음 = 멱등·비파괴).
  //     이 행이 곧 kill-switch 이자 R0↔R1 전환점. OFF 면 LEAD auto 자식이 승인대기로 강등(=R0 유지).
  const existingAutonomy = await db.prepare(
    `SELECT key FROM app_settings WHERE key = 'autonomy_enabled'`
  ).first()
  if (!existingAutonomy) {
    try {
      await db.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('autonomy_enabled', '0', ?)`
      ).bind(now).run()
    } catch { /* 동시 부팅 경쟁 무시 */ }
  }

  // (e) 엔진↔웹앱 분리(§4.2) 이관 대상 키 중 미착수였던 마지막 항목 — project_cycle 워커의
  //     안전 기본 max_turns(tool-profiles.js DEFAULT_MAX_TURNS). 없을 때만 INSERT, 기존 값 보존.
  const existingMaxTurns = await db.prepare(
    `SELECT key FROM app_settings WHERE key = 'engine.max_turns_default'`
  ).first()
  if (!existingMaxTurns) {
    try {
      await db.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('engine.max_turns_default', '8', ?)`
      ).bind(now).run()
    } catch { /* 동시 부팅 경쟁 무시 */ }
  }
}

/**
 * migrateInternalOpsKind — B4: 기존 라이브 내부운영(projects.kind='업무')을 'internal_ops' 로 값 마이그레이션.
 *
 * ⚠️ 반드시 autonomous-projects 화이트리스트 개조(lead.js, AUTONOMOUS_KINDS 에 'internal_ops' 포함)와 **짝**이다.
 *   화이트리스트만 바꾸고 '업무'를 안 옮기면 내부운영이 목록에서 탈락 → 라이브 자율 사망.
 *   반대로 값만 옮기고 화이트리스트에 internal_ops 가 없어도 사망. 둘을 함께 배포해야 한다.
 *
 * 멱등·비파괴: kind='업무' 인 행만 'internal_ops' 로 UPDATE(값 변경만, row 삭제/타입변경 없음).
 *   이미 'internal_ops' 면 매칭 0건 → no-op. 재실행 안전.
 *
 * 데이터 변경이므로 전후 카운트를 로그로 남긴다(회귀 검증 관측성).
 */
async function migrateInternalOpsKind(db) {
  try {
    const before = await db.prepare("SELECT COUNT(*) AS c FROM projects WHERE kind='업무'").first()
    const cnt = before?.c || 0
    if (cnt === 0) return // no-op(이미 마이그레이션됐거나 대상 없음).
    const res = await db.prepare(
      "UPDATE projects SET kind='internal_ops', updated_at=? WHERE kind='업무'"
    ).bind(new Date().toISOString()).run()
    const changed = res?.meta?.changes ?? '?'
    console.warn(`[migrate-kind] projects kind '업무'->'internal_ops': matched=${cnt} changed=${changed}`)
  } catch (e) {
    console.warn('[migrate-kind]', e?.message)
  }
}

/**
 * backfillProjectOwners — P0: owner_user_id 가 비어있는 기존 전 프로젝트를 admin(ADMIN_USERNAME)에 귀속.
 *
 * ⚠️ 블로커 B1 교정: owner_user_id 에는 **username**(=ADMIN_USERNAME)을 저장한다(user.id 아님).
 *   근거: JWT sub=username(auth.js), commands.created_by/reviewed_by=username → 승인함 스코핑 조인 키를
 *   username 으로 통일해야 command→project→owner 조인이 성립한다.
 *
 * 멱등·비파괴: owner_user_id IS NULL 인 행만 채운다(이미 소유자가 있는 행은 절대 덮지 않음).
 */
async function backfillProjectOwners(db) {
  try {
    const before = await db.prepare(
      'SELECT COUNT(*) AS c FROM projects WHERE owner_user_id IS NULL'
    ).first()
    const cnt = before?.c || 0
    if (cnt === 0) return // no-op(전부 소유자 있음).
    const res = await db.prepare(
      'UPDATE projects SET owner_user_id=?, updated_at=? WHERE owner_user_id IS NULL'
    ).bind(ADMIN_USERNAME, new Date().toISOString()).run()
    const changed = res?.meta?.changes ?? '?'
    console.warn(`[backfill-owner] projects owner_user_id=NULL -> '${ADMIN_USERNAME}': matched=${cnt} changed=${changed}`)
  } catch (e) {
    console.warn('[backfill-owner]', e?.message)
  }
}

/**
 * backfillActivityStructure — 활동 로그 재설계 백필(§3). 기존 행의 신규 구조 컬럼을 채운다.
 *
 * ⚠️ **데이터 변형(UPDATE)** → runDataMigrations 에만 등록(부팅 자동실행 절대 금지, 사고 2df98461 재발 방지).
 *   명시 트리거 `pnpm run migrate`(또는 MIGRATE_ON_BOOT=1)로만 실행된다.
 *
 * 멱등·비파괴: 전부 "해당 컬럼이 NULL/기본값인 행만" 채운다(재실행 안전). **detail 은 절대 UPDATE 안 함.**
 *
 * B2(§10) 실증: activity_logs 는 자율엔진이 실시간 INSERT 중이라 "before=after 동일" 가정은 오판한다.
 *   → 전 작업을 **단일 트랜잭션**으로 감싸 동시 INSERT 와 분리하고, 트랜잭션 내에서 countStart==countEnd
 *   (INSERT/DELETE=0) + detail 카운트 보존 + 각 UPDATE changes() 합산으로 "UPDATE만" 을 실증한다.
 *   §0의 절대수치(77건 등)는 스냅샷 → 하드코딩 가드 금지, 트랜잭션 내부 실측만 신뢰한다.
 */
async function backfillActivityStructure(db) {
  try {
    // detail 내 "..."/'...' 첫 인용구가 파일경로처럼 보이면 file: 슬러그로 추출(best-effort, 애매하면 NULL).
    const deriveTargetRef = (detail) => {
      if (!detail) return null
      const m = String(detail).match(/["']([^"']{2,150})["']/)
      if (!m) return null
      const val = m[1].trim()
      if (/[/\\]/.test(val) || /\.[a-z0-9]{1,6}$/i.test(val)) return 'file:' + val.replace(/^[/\\]+/, '')
      return null // 과도추론 금지
    }

    // 단일 트랜잭션 — 이 안의 prepare/run/get 은 원자적(동시 INSERT 와 분리).
    const s = db.transaction((tx) => {
      const run = (sql) => tx.prepare(sql).run().meta.changes
      const countStart = tx.prepare('SELECT COUNT(*) AS c FROM activity_logs').first().c
      const detailStart = tx.prepare('SELECT COUNT(*) AS c FROM activity_logs WHERE detail IS NOT NULL').first().c

      // 단계 1 — level 재분류(B). 기본값 'work' 인 것만(운영자 지정 보존).
      const lvlTelemetry = run(
        `UPDATE activity_logs SET level='telemetry'
          WHERE level='work'
            AND (agent_name='system'
                 OR action IN ('rule_queue','rule_auto','worker_parse_fail','lead_parse_fail',
                               'diff_path_rejected','backfill_stat'))`
      )
      // 설정변경 감사 → audit(사람이 알아야 함, 예외). level!='audit' 가드로 재실행 멱등
      //   (SQLite changes() 는 값 불변이어도 매칭행을 세므로, 이미 audit 인 행을 제외해야 2회차 changes=0).
      const lvlAudit = run(
        `UPDATE activity_logs SET level='audit'
          WHERE action IN ('autonomy_toggle','project_autonomy_update','config')
            AND level != 'audit'`
      )

      // 단계 2 — category 도출(A). NULL 인 행만. 매핑 없으면 안전 기본 'ops'.
      //   (server/lib/activity-normalize.js ACTION_CATEGORY 와 값 일치.)
      const cat = run(
        `UPDATE activity_logs SET category = CASE
            WHEN action IN ('create','implement','update') THEN 'build'
            WHEN action='milestone' THEN 'decision'
            WHEN action='config' THEN 'deploy'
            WHEN action IN ('backfill','bootstrap','operator-activation') THEN 'ops'
            WHEN action IN ('rule_queue','rule_auto','worker_parse_fail','lead_parse_fail',
                            'diff_path_rejected','autonomy_toggle') THEN 'system'
            ELSE 'ops'
          END
          WHERE category IS NULL`
      )

      // 단계 3 — title 채움. detail 앞머리 120자(파생 요약, detail 원문 보존).
      const title = run(
        `UPDATE activity_logs SET title = substr(detail, 1, 120)
          WHERE title IS NULL AND detail IS NOT NULL`
      )

      // 단계 4 — result 추론(보수적). fail/rejected→failed, rule_auto/milestone→success, 나머지 NULL.
      const result = run(
        `UPDATE activity_logs SET result = CASE
            WHEN action LIKE '%fail%' OR action LIKE '%rejected%' THEN 'failed'
            WHEN action IN ('rule_auto','milestone') THEN 'success'
          END
          WHERE result IS NULL
            AND (action LIKE '%fail%' OR action LIKE '%rejected%'
                 OR action IN ('rule_auto','milestone'))`
      )

      // 단계 5 — target_ref 도출(best-effort). detail 내 인용 파일경로만, 실패해도 무해.
      const rows = tx.prepare(
        `SELECT id, detail FROM activity_logs WHERE target_ref IS NULL AND detail IS NOT NULL`
      ).all().results
      const upd = tx.prepare(`UPDATE activity_logs SET target_ref=? WHERE id=? AND target_ref IS NULL`)
      let targetRef = 0
      for (const r of rows) {
        const ref = deriveTargetRef(r.detail)
        if (ref) targetRef += upd.bind(ref, r.id).run().meta.changes
      }

      const countEnd = tx.prepare('SELECT COUNT(*) AS c FROM activity_logs').first().c
      const detailEnd = tx.prepare('SELECT COUNT(*) AS c FROM activity_logs WHERE detail IS NOT NULL').first().c
      return { countStart, countEnd, detailStart, detailEnd, lvlTelemetry, lvlAudit, cat, title, result, targetRef }
    }, 'immediate') // m-5: BEGIN IMMEDIATE — 쓰기락 선점으로 countStart↔첫 UPDATE 레이스 창 제거.

    const totalChanges = s.lvlTelemetry + s.lvlAudit + s.cat + s.title + s.result + s.targetRef
    const rowsPreserved = s.countStart === s.countEnd // INSERT/DELETE=0 실증(트랜잭션 내 스냅샷)
    const detailPreserved = s.detailStart === s.detailEnd // detail 원문 보존 실증
    console.warn(
      `[backfill-activity] rows=${s.countStart}->${s.countEnd} (preserved=${rowsPreserved}) ` +
      `detail_notnull=${s.detailStart}->${s.detailEnd} (preserved=${detailPreserved}) ` +
      `updates: level_telemetry=${s.lvlTelemetry} level_audit=${s.lvlAudit} category=${s.cat} ` +
      `title=${s.title} result=${s.result} target_ref=${s.targetRef} totalChanges=${totalChanges}`
    )
    if (!rowsPreserved) console.warn('[backfill-activity] ⚠️ row count changed inside tx — INSERT/DELETE 발생(계약 위반)')
    if (!detailPreserved) console.warn('[backfill-activity] ⚠️ detail not-null count changed — detail 변형 의심(계약 위반)')
  } catch (e) {
    console.warn('[backfill-activity]', e?.message)
  }
}

/**
 * admin 사용자 시드 — lockout 방지(매우 중요).
 *
 * users 가 비어 있고 ADMIN_PASSWORD 가 있으면 username 'admin' 을 그 비번 해시로 생성한다
 * (totp_enabled=0). 이미 admin 이 있으면 아무것도 하지 않는다(멱등).
 * 이로써 기존 ADMIN_PASSWORD 로 계속 로그인할 수 있다.
 * 비번 미설정/이미 사용자 존재 시 no-op.
 *
 * role='super_admin'(락아웃 방지) — 빈 DB에 생성되는 최초 유일 계정은 반드시 최고권한이어야
 *   사용자관리/자율제어판 등 super_admin 전용 기능에 아무도 접근 못 하는 상황을 피할 수 있다.
 */
async function seedAdminUser(db, adminPassword) {
  if (!adminPassword) return // 비번 없으면 시드 불가(개발 기본비번은 로그인 측에서 처리).
  const usersDao = new UsersDao(db)
  const existing = await usersDao.findByUsername(ADMIN_USERNAME)
  if (existing) return // 이미 있음 → 절대 덮어쓰지 않음(멱등).
  const total = await usersDao.count()
  if (total > 0) return // 다른 사용자가 이미 있으면 자동 시드 안 함(운영 데이터 보호).
  const { hash, salt } = await hashPassword(adminPassword)
  try {
    await usersDao.create({ username: ADMIN_USERNAME, passwordHash: hash, passwordSalt: salt, role: 'super_admin' })
  } catch { /* 동시 부팅 경쟁 등으로 이미 생성됐으면 무시 */ }
}

/**
 * 기존 'admin' 계정을 이메일 ID(ADMIN_USERNAME)로 1회 rename.
 *
 * 과거 배포는 username='admin' 으로 시드돼 있다. 비번/TOTP secret 은 그대로 두고
 * username 만 바꿔 로그인 ID 를 이메일로 전환한다. 멱등:
 *  - 'admin' 이 없으면(이미 전환됐거나 신규 시드) no-op.
 *  - 이미 ADMIN_USERNAME 이 존재하면(충돌) 건드리지 않는다.
 */
async function renameLegacyAdmin(db) {
  const usersDao = new UsersDao(db)
  const legacy = await usersDao.findByUsername('admin')
  if (!legacy) return
  const target = await usersDao.findByUsername(ADMIN_USERNAME)
  if (target) return // 충돌 — 수동 정리 필요. 자동 덮어쓰지 않음.
  try {
    await usersDao.updateUsername(legacy.id, ADMIN_USERNAME)
  } catch { /* 동시 실행 경쟁 등은 무시 */ }
}

/**
 * runDataMigrations — **기존 행을 변형하는(UPDATE/backfill) 데이터 마이그레이션**만 모은 진입점.
 *
 * ⚠️ 이 함수는 부팅에서 자동 실행되지 않는다(사고 2df98461 근본원인 차단).
 *   서버 LaunchAgent(KeepAlive)가 코드 저장 순간 재기동하며 ensureSchema 를 돌리는데, 여기에
 *   데이터 변형이 섞여 있으면 "코드 저장 = 라이브 데이터 변형"이 된다. 그래서 데이터 변형은
 *   ① 명시 트리거(`pnpm run migrate`) 또는 ② 환경플래그 MIGRATE_ON_BOOT=1 로만 실행한다.
 *
 * 여기 담기는 것(위험, 게이트 대상):
 *   - migrateInternalOpsKind: projects.kind '업무'->'internal_ops' UPDATE(B4)
 *   - backfillProjectOwners:  owner_user_id NULL->admin UPDATE(P0)
 *   - (향후 유사 backfill/데이터 정합 UPDATE 는 전부 여기에 추가)
 *
 * 담기지 않는 것(안전, 부팅 유지):
 *   - 비파괴 DDL(ADD COLUMN nullable / CREATE TABLE IF NOT EXISTS / 인덱스) → ensureSchema 본체.
 *   - 신규환경 부트스트랩 시드(seedLeadLoop/admin) → INSERT-if-missing 이라 부팅 유지.
 *
 * 전부 멱등(대상 0건이면 no-op)이라 여러 번 돌려도 안전하다.
 */
export async function runDataMigrations(db) {
  // B4: kind '업무'->'internal_ops' — seedLeadLoop UPDATE 는 두 값 모두 매칭하므로 순서 무관하지만,
  //   정합을 위해 kind 를 먼저 옮긴다.
  try { await migrateInternalOpsKind(db) } catch (e) { console.warn('[migrate-kind]', e?.message) }
  // P0: 기존 전 프로젝트 owner_user_id backfill = admin(username). NULL 인 행만.
  try { await backfillProjectOwners(db) } catch (e) { console.warn('[backfill-owner]', e?.message) }
  // 활동 로그 재설계: 기존 activity_logs 신규 구조 컬럼 백필(level/category/title/result/target_ref).
  //   단일 트랜잭션 + changes() 실증. detail 불변. 멱등(대상 NULL 행만).
  try { await backfillActivityStructure(db) } catch (e) { console.warn('[backfill-activity]', e?.message) }
  // 실행 인프라 재설계 Phase B(§1.8) 마무리 — tasks 원본 테이블 + 잔존 task_id 컬럼(decisions/issues/
  //   commands/activity_logs/memories) 제거 및 command_id 리네임은 라이브에 적용 완료(2026-07-03),
  //   이후 매 실행이 영구 no-op 이던 dropTasksTable/renameTaskIdToCommandId 함수는 2026-07-15
  //   실측 재확인(테이블 부재·컬럼명 command_id 확인) 후 제거(이슈 d6295cc1).
}

/**
 * verifySchema — **부팅 읽기전용 가드**. 스키마를 만들지 않고 버전만 대조한다.
 *
 * db:migrate 가 _schema_meta.version 에 스탬프한 지문과 디스크(schema.sql+migrations) 지문을 비교:
 *   - 지문 행 없음 → 아직 `pnpm run db:migrate` 안 함(신규/미초기화)
 *   - 지문 불일치  → schema.sql/migrations 를 고쳐놓고 db:migrate 를 안 돌림(드리프트)
 * 둘 다 부팅을 막아(throw), 스키마 변경이 db:migrate 한 곳을 반드시 거치게 강제한다.
 */
export async function verifySchema(db) {
  const expected = computeSchemaVersion()
  let row = null
  try {
    row = await db.prepare(`SELECT value FROM _schema_meta WHERE key = 'version'`).first()
  } catch { /* _schema_meta 자체가 없음 = 미초기화 */ }
  if (!row) {
    throw new Error('[schema] DB 미초기화 — 먼저 `pnpm run db:migrate` 를 실행하세요.')
  }
  if (row.value !== expected) {
    throw new Error(
      `[schema] 스키마 드리프트: DB=${row.value} 파일=${expected}. ` +
      '변경을 반영하려면 `pnpm run db:migrate` 를 실행하세요.'
    )
  }
}

/**
 * ensureSchema — **부팅 진입부**. 스키마는 절대 만들지 않는다(verifySchema 로 대조만).
 *
 * 테이블/인덱스 생성·변경은 오직 `pnpm run db:migrate`(schema.sql + migrations)가 담당한다.
 * 여기서는 (1) 스키마 버전 가드 + (2) 데이터 부트스트랩 시드(INSERT-if-missing, 테이블 관리 아님)만.
 * 데이터 변형 마이그레이션(backfill 등)은 `pnpm run migrate`(bin/migrate.js) 명시 트리거로 분리.
 *
 * @param {object} db
 * @param {object} [options]
 * @param {string} [options.adminPassword]
 */
export async function ensureSchema(db, options = {}) {
  if (initialized) {
    // admin 시드는 매번 멱등 확인(부팅 시 비번이 늦게 주입될 수 있음).
    if (options.adminPassword) {
      try { await renameLegacyAdmin(db) } catch { /* 치명 아님 */ }
      try { await seedAdminUser(db, options.adminPassword) } catch { /* 치명 아님 */ }
    }
    return
  }
  // ① 스키마 버전 가드 — 미초기화/드리프트면 여기서 throw(부팅 중단, 안내 메시지).
  await verifySchema(db)
  // ② 데이터 부트스트랩 시드(안전, INSERT-if-missing) — 테이블은 이미 db:migrate 로 존재.
  //   마스터 자율 스위치(kill-switch, 기본 OFF) 시드. 멱등.
  try { await seedLeadLoop(db) } catch (e) { console.warn('[seedLeadLoop]', e?.message) }
  // 기존 'admin' → 이메일 ID 로 1회 rename(있을 때만). 시드보다 먼저 실행.
  try { await renameLegacyAdmin(db) } catch { /* 치명 아님 */ }
  // admin 사용자 시드(lockout 방지). 비번 있고 users 비었을 때만 1회.
  try { await seedAdminUser(db, options.adminPassword) } catch { /* 치명 아님 */ }
  initialized = true
}
