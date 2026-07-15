#!/usr/bin/env node
// bin/db-migrate.js — **스키마 변경의 유일한 경로**(`pnpm run db:migrate`).
//
// 대표(사람)가 의도적으로 실행하는 이 진입점으로만 라이브 DB 의 테이블/인덱스가 바뀐다.
// 웹서버 부팅과 MCP 는 스키마를 만들지 않는다(부팅은 verifySchema 읽기전용 가드만).
//
// 동작:
//   1) .dev.vars 로드 → DB_PATH 확정(server/node.js 와 동일 규칙).
//   2) (기본) pre-migrate 백업(VACUUM INTO data/backups/pre-db-migrate-<ts>.db) + 무결성 검증.
//   3) schema.sql 적용(전부 IF NOT EXISTS = 재실행 안전, 신규 DB 부트스트랩).
//   4) migrations/*.sql 중 미적용분을 파일명 순서로 트랜잭션 적용 → _migrations 에 기록.
//   5) 현재 스키마 지문을 _schema_meta.version 에 스탬프(부팅 가드가 이걸 대조).
//
// 플래그: --no-backup(백업 생략), --dry-run(적용 없이 계획만 출력).
//
// ⚠️ 파괴적 변경(DROP/ALTER)은 migrations/*.sql 에 명시적으로 적는다. schema.sql 은 "현재 전체 그림"
//    (IF NOT EXISTS)이라 기존 테이블을 바꾸지 못한다 — 변형은 migration 이 담당한다.

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { SCHEMA_PATH, MIGRATIONS_DIR, listMigrations, computeSchemaVersion } from '../server/lib/schema-version.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function loadDotVars(path) {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadDotVars(join(ROOT, '.dev.vars'))

const DB_PATH = process.env.DB_PATH || process.env.MALGNAI_DB_PATH || join(ROOT, 'data', 'malgnai.db')
const DRY = process.argv.includes('--dry-run')
// ⚠️ --no-backup: 라이브(운영) DB에는 쓰지 말 것 — 로컬 스크래치 DB/테스트 전용. 운영에선 항상 사전백업(VACUUM INTO)을 남긴다.
const NO_BACKUP = process.argv.includes('--no-backup')
const ts = () => new Date().toISOString().replace(/[:.]/g, '-')

function main() {
  console.log(`[db:migrate] DB=${DB_PATH}`)
  const fresh = !existsSync(DB_PATH)
  if (fresh) console.log('[db:migrate] 신규 DB — schema.sql 로 부트스트랩한다.')

  const pending = listMigrations() // 적용여부는 DB 연 뒤 판별
  if (DRY) {
    console.log(`[db:migrate] --dry-run: schema.sql 적용 + migrations 후보 ${pending.length}개(${pending.join(', ') || '없음'}). 실제 변경 없음.`)
    return
  }

  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  // better-sqlite3(macOS)가 PRAGMA foreign_keys = ON으로 컴파일됨.
  // schema.sql + migrations 실행 중 FK가 활성화돼 있으면 DROP TABLE 이 CASCADE 를 트리거해
  // 참조 테이블 데이터를 삭제/NULL화한다. 마이그레이션 세션만 비활성화하고 종료 시 복원한다.
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1
  if (fkWasOn) db.pragma('foreign_keys = OFF')

  // 2) pre-migrate 백업(기존 DB일 때만).
  if (!fresh && !NO_BACKUP) {
    const backupDir = join(ROOT, 'data', 'backups')
    mkdirSync(backupDir, { recursive: true })
    const backupPath = join(backupDir, `pre-db-migrate-${ts()}.db`)
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
    const chk = new Database(backupPath, { readonly: true })
    const ok = chk.prepare('PRAGMA integrity_check').get()
    chk.close()
    const integrity = ok && ok.integrity_check === 'ok'
    console.log(`[db:migrate] backup -> ${backupPath} (integrity=${integrity ? 'ok' : 'FAIL'})`)
    if (!integrity) { console.error('[db:migrate] 백업 무결성 실패 — 중단(라이브 미변경).'); db.close(); process.exit(2) }
  } else if (NO_BACKUP) {
    console.log('[db:migrate] --no-backup: 백업 생략(주의).')
  }

  // 메타 테이블 보장.
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`)

  // 3) schema.sql 적용(IF NOT EXISTS = 멱등).
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
  console.log('[db:migrate] schema.sql 적용 완료')

  // 4) 미적용 migrations 를 파일명 순서로 트랜잭션 적용.
  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name))
  let n = 0
  for (const f of listMigrations()) {
    if (applied.has(f)) continue
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString())
    })()
    n++
    console.log('[db:migrate] migration 적용:', f)
  }
  console.log(n ? `[db:migrate] migrations ${n}개 적용` : '[db:migrate] 미적용 migration 없음')

  // 5) 버전 스탬프.
  const version = computeSchemaVersion()
  db.prepare(
    `INSERT INTO _schema_meta (key, value, updated_at) VALUES ('version', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(version, new Date().toISOString())
  console.log('[db:migrate] schema version =', version)

  if (fkWasOn) db.pragma('foreign_keys = ON')
  db.close()
  console.log('[db:migrate] done')
}

main()
