/**
 * engine/db.js — 엔진 전용 DB 커넥션(Phase 2, docs/design/engine-webapp-separation.md §3.2/§4.1).
 *
 * server/node.js 와 완전히 같은 규칙으로 .dev.vars 를 로드하고 DB_PATH 를 해석한다 — 두 프로세스가
 * "같은 파일을 가리키는 것"이 목적이므로, 새 env 파일을 만들지 않고 기존 `.dev.vars` 하나만 공유한다
 * (§4.1: "환경변수는 이 파일 하나"). 연 직후 busy_timeout pragma 를 반드시 설정한다(§3.3-2, 두
 * 프로세스가 동시에 같은 sqlite 파일에 쓰기 트랜잭션을 시도할 때 짧은 경합을 자동 재시도로 흡수).
 *
 * server/dao/*.js 가 기대하는 D1 호환 표면(prepare/bind/all/first/run, transaction)은
 * server/db/sqlite-adapter.js 의 wrapD1() 로 그대로 재사용한다(중복 구현 금지).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { wrapD1 } from '../server/db/sqlite-adapter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(__dirname, '..')

// ── .dev.vars 자동 로드 (server/node.js loadDotVars 와 동일 로직) ──────────────
function loadDotVars(path) {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const raw of text.split(/\r?\n/)) {
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

// 정본 DB(server/node.js 와 동일 해석 규칙 — 파일이 하나뿐이므로 두 프로세스 DB_PATH 가 갈릴 수 없다).
export const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'malgnai.db')

/**
 * openEngineDb — 엔진 전용 better-sqlite3 커넥션을 열고 D1 호환 어댑터로 감싸 반환한다.
 * @param {string} [dbPath]  테스트 등에서 다른 경로(예: 인메모리 ':memory:' 또는 임시 파일)를 쓰고 싶을 때 오버라이드.
 * @returns {{ db: object, sqlite: import('better-sqlite3').Database, close: () => void }}
 */
export function openEngineDb(dbPath = DB_PATH) {
  const sqlite = new Database(dbPath)
  // §3.3-2: 두 프로세스(server/node.js, engine/db.js) 모두 부팅 시 설정 — 짧은 쓰기 경합을 자동 재시도로 흡수.
  sqlite.pragma('busy_timeout = 5000')
  const db = wrapD1(sqlite)
  return { db, sqlite, close: () => sqlite.close() }
}
