#!/usr/bin/env node
// administrator 계정 시드 스크립트.
//
// CLI 인자 또는 환경변수로 이메일+평문 비밀번호를 받아 서버와 동일한 해시 함수
// (server/lib/tokens.js의 hashPassword — Web Crypto PBKDF2-SHA256)로 해시한 뒤,
// `wrangler d1 execute`로 users 테이블에 UPSERT한다(organizations 없음 → 조직 시드 단계 없음,
// architecture.md §9.2 step3).
//
// [COO 지시] 이 스크립트는 지금 실행하지 않는다 — 실행은 devops 단계에서 실제 administrator
// 이메일/비밀번호로 대표가 직접 돌린다.
//
// 사용법:
//   node scripts/seed-admin.mjs --email admin@malgnsoft.com --password '<strong-pw>' --name '관리자' [--remote]
//   또는 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_NAME / SEED_ADMIN_REMOTE=1 환경변수로 전달 가능.
// 기본은 --local(로컬 D1)이다 — --remote를 명시해야 실제 배포 DB에 적용된다.
import { spawnSync } from 'node:child_process'
import { hashPassword } from '../server/lib/tokens.js'
import { newId } from '../server/lib/ulid.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--remote') {
      out.remote = true
      continue
    }
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1]
      i++
    }
  }
  return out
}

function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''")
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const email = (args.email || process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase()
  const password = args.password || process.env.SEED_ADMIN_PASSWORD || ''
  const name = args.name || process.env.SEED_ADMIN_NAME || 'Administrator'
  const remote = Boolean(args.remote || process.env.SEED_ADMIN_REMOTE)

  if (!email || !email.includes('@')) {
    console.error('오류: 유효한 --email 이 필요합니다.')
    process.exit(1)
  }
  if (!password || password.length < 12) {
    console.error('오류: --password 는 최소 12자 이상이어야 합니다.')
    process.exit(1)
  }

  const passwordHash = await hashPassword(password)
  const id = newId()
  const now = new Date().toISOString()

  const sql = [
    'INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)',
    `VALUES ('${escapeSqlLiteral(id)}', '${escapeSqlLiteral(email)}', '${escapeSqlLiteral(name)}', '${escapeSqlLiteral(passwordHash)}', 'administrator', 'active', '${now}', '${now}')`,
    'ON CONFLICT(email) DO UPDATE SET',
    '  name = excluded.name,',
    '  password_hash = excluded.password_hash,',
    "  role = 'administrator',",
    "  status = 'active',",
    '  updated_at = excluded.updated_at;'
  ].join('\n')

  const flag = remote ? '--remote' : '--local'
  console.log(`[seed-admin] wrangler d1 execute malgnai-hub ${flag} 실행 중... (email=${email})`)
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'malgnai-hub', flag, '--command', sql], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('[seed-admin] 실패')
    process.exit(result.status || 1)
  }
  console.log('[seed-admin] 완료')
}

main()
