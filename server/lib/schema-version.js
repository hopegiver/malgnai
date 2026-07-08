// schema-version.js — 스키마 정본(schema.sql) + 변경분(migrations/*.sql)의 버전 지문.
//
// db:migrate 가 라이브 DB(_schema_meta.version)에 이 지문을 스탬프하고,
// 웹서버 부팅(verifySchema)이 디스크에서 같은 지문을 재계산해 대조한다.
//   - DB 에 지문 없음  → 아직 db:migrate 안 함(신규/미초기화)
//   - 지문 불일치       → schema.sql/migrations 를 고쳐놓고 db:migrate 를 안 돌림(드리프트)
// 둘 다 부팅을 막아, 스키마 변경은 반드시 `pnpm run db:migrate` 한 곳을 거치게 한다.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// server/lib/schema-version.js → 저장소 루트
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const SCHEMA_PATH = join(ROOT, 'schema.sql')
export const MIGRATIONS_DIR = join(ROOT, 'migrations')

// 적용 순서 = 파일명 오름차순. NNN-이름.sql 규칙(001-…, 002-…)을 쓴다.
export function listMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) return []
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
}

// schema.sql 본문 + 각 migration(파일명+본문)을 해싱. 앞 16자만 버전으로 쓴다.
export function computeSchemaVersion() {
  const h = createHash('sha256')
  h.update(readFileSync(SCHEMA_PATH, 'utf8'))
  for (const f of listMigrations()) {
    h.update('\0' + f + '\0')
    h.update(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  }
  return h.digest('hex').slice(0, 16)
}
