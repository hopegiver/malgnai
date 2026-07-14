#!/usr/bin/env node
// bin/cleanup-test-data.js — 테스트가 남긴 잔존 데이터 정리(안전망, `pnpm run cleanup:test-data`).
//
// 배경(2026-07-14 사고): e2e/vitest 통합테스트는 실행 중인 로컬 서버(:9000)의 진짜 sqlite
// (data/malgnai.db)를 그대로 쓴다(대표 지시 — 별도 DB 분리보다 "쓰되 반드시 정리"가 정책).
// 정상 경로에서는 각 테스트의 afterAll이 스스로 지우지만, 다음 두 경우 자식 행이 영구 잔존한다:
//   1) ProjectsDao.delete()가 자식 테이블(commands/activity_logs/decisions/issues/memories/
//      project_collaborators)을 함께 지우도록 2026-07-14에 고쳤지만(server/dao/projects.js),
//      이 스크립트 실행 시점 이전에 이미 삭제된 프로젝트의 자식 행은 여전히 고아로 남아있다
//      (migrations/003-drop-foreign-keys.sql로 FK가 전부 제거돼 DB 엔진 CASCADE가 없었기 때문 —
//      실측 시점 기준 46개 삭제된 프로젝트에 걸쳐 81개 고아 commands 확인).
//   2) 프로젝트 자체가 안 지워지고 남는 경우(예: DELETE API 호출이 조용히 실패 — ownership
//      드리프트, 서버 재시작 타이밍 등). test/e2e/phase-chain-e2e.test.js가 남긴
//      test-phase-chain-e2e-* 프로젝트 10개가 실제 사례.
//
// 이 스크립트는 두 종류의 잔존물만 다룬다(둘 다 이름/내용 접두사로 "테스트임"이 명백한 경우만):
//   (a) 프로젝트: name이 'test-'로 시작하는 projects 행 + 그 자식(commands 등) 전부.
//   (b) 고아 commands: project_id가 이미 projects 테이블에 없고 instruction이 '[TEST]'로
//       시작하는 행(= 부모 프로젝트는 지워졌지만 이 commands 자체는 안 지워진 경우).
// 그 외 고아(예: instruction이 '[TEST]'로 시작하지 않는 것)는 절대 자동 삭제하지 않고
// "검토 필요"로만 보고한다 — 실제 프로젝트 삭제로 생긴 진짜 데이터일 수 있다.
//
// 안전장치: malgnai 자기 자신(id 고정, name='malgnai')은 이름이 'test-'로 시작할 수 없어
// 후보에 아예 오르지 않지만, 방어적으로 한 번 더 명시 제외한다.
//
// 기본은 --dry-run(미리보기만, 아무것도 안 지움). 실제 삭제는 --apply 를 명시해야 한다.

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { PROJECT_CHILD_TABLES } from '../server/lib/project-child-tables.js'

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
const APPLY = process.argv.includes('--apply')

// malgnai 프로젝트 자신 — 절대 삭제 후보가 될 수 없다(이중 안전장치, name 조건과 별개로 명시 배제).
const MALGNAI_SELF_ID = 'b00eaa81-7cea-4e38-b1bc-8cb024974cd9'

function main() {
  console.log(`[cleanup-test-data] DB=${DB_PATH} mode=${APPLY ? 'APPLY(실제 삭제)' : 'dry-run(미리보기만)'}`)
  const db = new Database(DB_PATH)
  try {
    // (a) name이 'test-'로 시작하는 프로젝트 후보.
    const projectCandidates = db.prepare(
      `SELECT id, name, status, created_at FROM projects WHERE name LIKE 'test-%' AND id != ? ORDER BY created_at`
    ).all(MALGNAI_SELF_ID)

    console.log(`\n[a] 삭제 후보 프로젝트: ${projectCandidates.length}건`)
    for (const p of projectCandidates) {
      const counts = PROJECT_CHILD_TABLES.map((t) => {
        const row = db.prepare(`SELECT count(*) AS n FROM ${t} WHERE project_id = ?`).get(p.id)
        return `${t}=${row.n}`
      }).join(', ')
      console.log(`  - ${p.id}  ${p.name}  [${p.status}]  created=${p.created_at}  (${counts})`)
    }

    // (b) 부모 프로젝트가 이미 없고 instruction이 '[TEST]'로 시작하는 고아 commands.
    const orphanCommands = db.prepare(
      `SELECT id, project_id, substr(instruction,1,60) AS instr, created_at FROM commands
       WHERE project_id NOT IN (SELECT id FROM projects) AND instruction LIKE '[TEST]%'
       ORDER BY created_at`
    ).all()
    console.log(`\n[b] 삭제 후보 고아 commands([TEST] 접두사, 부모 프로젝트 없음): ${orphanCommands.length}건`)
    for (const c of orphanCommands) {
      console.log(`  - ${c.id}  project_id=${c.project_id}  "${c.instr}"  created=${c.created_at}`)
    }

    // 검토 필요(자동 삭제 대상 아님) — 부모 없는 고아인데 '[TEST]' 접두사가 아닌 것.
    const reviewNeeded = db.prepare(
      `SELECT id, project_id, substr(instruction,1,60) AS instr, created_at FROM commands
       WHERE project_id NOT IN (SELECT id FROM projects) AND instruction NOT LIKE '[TEST]%'
       ORDER BY created_at`
    ).all()
    if (reviewNeeded.length) {
      console.log(`\n[검토 필요] 부모 없는 고아 commands 중 '[TEST]' 접두사가 아닌 것 (자동 삭제 안 함): ${reviewNeeded.length}건`)
      for (const c of reviewNeeded) {
        console.log(`  ? ${c.id}  project_id=${c.project_id}  "${c.instr}"  created=${c.created_at}`)
      }
    }

    if (!APPLY) {
      console.log(`\n[cleanup-test-data] dry-run 종료 — 실제로 지우려면 --apply 를 붙여 다시 실행하세요.`)
      return
    }

    if (projectCandidates.length === 0 && orphanCommands.length === 0) {
      console.log(`\n[cleanup-test-data] 지울 대상이 없습니다.`)
      return
    }

    // 'immediate' — server/dao/projects.js ProjectsDao.delete()와 동일 근거(reviewer 지적,
    // 2026-07-14 보강). ACTIVE_COMMAND 체크와 실제 삭제 사이에 다른 프로세스(엔진 poll)가
    // command 를 claim 하는 TOCTOU 창을 BEGIN IMMEDIATE 로 원천 차단한다.
    const tx = db.transaction(() => {
      let deletedProjects = 0
      let deletedChildRows = 0
      let skippedActive = 0
      for (const p of projectCandidates) {
        if (p.id === MALGNAI_SELF_ID) continue // 방어적 이중 체크
        const active = db.prepare(
          `SELECT count(*) AS n FROM commands WHERE project_id = ? AND status IN ('claimed', 'running')`
        ).get(p.id)
        if (active && active.n > 0) {
          console.log(`  [SKIP] ${p.id} ${p.name} — claimed/running command가 있어 삭제 건너뜀`)
          skippedActive++
          continue
        }
        for (const t of PROJECT_CHILD_TABLES) {
          const info = db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(p.id)
          deletedChildRows += info.changes
        }
        const info = db.prepare('DELETE FROM projects WHERE id = ?').run(p.id)
        deletedProjects += info.changes
      }
      let deletedOrphans = 0
      for (const c of orphanCommands) {
        // 고아 command 자신이 claimed/running이면(부모 프로젝트는 지워졌지만 실행은 여전히
        // 진행 중인 극단적 엣지케이스) 워커가 결과를 쓸 대상을 지우지 않도록 건너뛴다.
        const row = db.prepare(`SELECT status FROM commands WHERE id = ?`).get(c.id)
        if (row && (row.status === 'claimed' || row.status === 'running')) {
          console.log(`  [SKIP] ${c.id} — claimed/running 상태라 삭제 건너뜀`)
          skippedActive++
          continue
        }
        const info = db.prepare('DELETE FROM commands WHERE id = ?').run(c.id)
        deletedOrphans += info.changes
      }
      return { deletedProjects, deletedChildRows, deletedOrphans, skippedActive }
    })

    // better-sqlite3 트랜잭션 래퍼는 .immediate()/.exclusive()/.deferred() 변형으로 BEGIN 모드를
    // 고른다(2인자로 넘기는 게 아니다) — server/db/sqlite-adapter.js의 D1 호환 파사드와는 다른
    // raw better-sqlite3 API라 여기서는 직접 .immediate()를 호출한다.
    const result = tx.immediate()
    console.log(`\n[cleanup-test-data] 삭제 완료: 프로젝트 ${result.deletedProjects}건, 자식행(commands 등) ${result.deletedChildRows}건, 고아 commands ${result.deletedOrphans}건${result.skippedActive ? `, 건너뜀(진행 중) ${result.skippedActive}건` : ''}.`)
  } finally {
    db.close()
  }
}

main()
