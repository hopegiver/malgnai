#!/usr/bin/env node
// bin/migrate.js — **데이터 마이그레이션 명시 트리거**(`pnpm run migrate`).
//
// 사고 2df98461 근본원인 차단: 데이터 변형(UPDATE/backfill)을 서버 부팅에서 떼어내고,
// 사람이 의도적으로 1회 실행하는 이 진입점으로만 돌린다(ensureSchema 는 부팅에서 데이터 변형 skip).
//
// 동작:
//   1) .dev.vars 로드 → DB_PATH 확정(server/node.js 와 동일 규칙).
//   2) 실행 전 **pre-migrate 백업**(VACUUM INTO data/backups/pre-migrate-<ts>.db) — 무결성 검증 포함.
//   3) ensureSchema(db, { runDataMigrations:true }) — DDL 보장 + 데이터 마이그레이션을 명시 실행.
//   4) 전후 요약 로그.
//
// ⚠️ 라이브에 돌릴 때는 서버 LaunchAgent 정지 상태에서(또는 백업 확인 후) 실행 권장.
//   전부 멱등이라 이미 적용된 상태에서 재실행해도 no-op(대상 0건)이다.

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { wrapD1 } from '../server/db/sqlite-adapter.js'
import { verifySchema, runDataMigrations } from '../server/dao/init.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ── .dev.vars 로드(server/node.js 와 동일: 이미 설정된 env 는 보존) ──
function loadDotVars(path) {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadDotVars(join(ROOT, '.dev.vars'))

const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'malgnai.db')
const DRY = process.argv.includes('--dry-run')
// ⚠️ --no-backup: 라이브(운영) DB에는 쓰지 말 것 — 로컬 스크래치 DB/테스트 전용. 운영에선 항상 사전백업을 남긴다.
const NO_BACKUP = process.argv.includes('--no-backup')

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function main() {
  console.log(`[migrate] DB=${DB_PATH}`)
  if (!existsSync(DB_PATH)) {
    console.error(`[migrate] DB not found: ${DB_PATH}`)
    process.exit(1)
  }

  const sqlite = new Database(DB_PATH)

  // 1) 전 상태 요약(관측성).
  const before = {
    projects: sqlite.prepare('SELECT COUNT(*) c FROM projects').get().c,
    eupmu: safeCount(sqlite, "SELECT COUNT(*) c FROM projects WHERE kind='업무'"),
    ownerNull: safeCount(sqlite, 'SELECT COUNT(*) c FROM projects WHERE owner_user_id IS NULL'),
  }
  console.log('[migrate] BEFORE:', JSON.stringify(before))

  if (DRY) {
    console.log('[migrate] --dry-run: 백업/실행 없이 종료. 위 BEFORE 가 대상 규모.')
    sqlite.close()
    return
  }

  // 2) pre-migrate 백업(VACUUM INTO) — 원자적 스냅샷 + 무결성 검증.
  if (!NO_BACKUP) {
    const backupDir = join(ROOT, 'data', 'backups')
    mkdirSync(backupDir, { recursive: true })
    const backupPath = join(backupDir, `pre-migrate-${ts()}.db`)
    // VACUUM INTO 는 대상 파일이 없어야 한다(mkdir 만 하고 파일은 생성 X).
    sqlite.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
    // 무결성 검증(백업이 온전한지).
    const chk = new Database(backupPath, { readonly: true })
    const ok = chk.prepare('PRAGMA integrity_check').get()
    const bcnt = chk.prepare('SELECT COUNT(*) c FROM projects').get().c
    chk.close()
    const integrity = ok && (ok.integrity_check === 'ok')
    console.log(`[migrate] backup -> ${backupPath} (integrity=${integrity ? 'ok' : 'FAIL'}, projects=${bcnt})`)
    if (!integrity || bcnt !== before.projects) {
      console.error('[migrate] 백업 무결성/카운트 불일치 — 마이그레이션 중단(라이브 미변경).')
      sqlite.close()
      process.exit(2)
    }
  } else {
    console.log('[migrate] --no-backup: 백업 생략(주의).')
  }

  // 3) 명시 트리거로 데이터 마이그레이션(backfill 등) 실행.
  //   스키마(테이블/인덱스)는 db:migrate 소관이라 여기선 안 건드린다 — 먼저 스키마 버전만 대조(가드).
  const db = wrapD1(sqlite)
  await verifySchema(db)          // 미초기화/드리프트면 throw → "먼저 pnpm run db:migrate"
  await runDataMigrations(db)

  // 4) 후 상태 요약.
  const after = {
    projects: sqlite.prepare('SELECT COUNT(*) c FROM projects').get().c,
    eupmu: safeCount(sqlite, "SELECT COUNT(*) c FROM projects WHERE kind='업무'"),
    ownerNull: safeCount(sqlite, 'SELECT COUNT(*) c FROM projects WHERE owner_user_id IS NULL'),
  }
  console.log('[migrate] AFTER:', JSON.stringify(after))
  console.log(`[migrate] done. row 보존=${after.projects >= before.projects ? 'ok' : 'CHECK'} ('업무'->${after.eupmu}, ownerNull->${after.ownerNull})`)
  sqlite.close()
}

function safeCount(db, sql) {
  try { return db.prepare(sql).get().c } catch { return 'n/a' }
}

main().catch((e) => { console.error('[migrate] FAILED:', e); process.exit(1) })
