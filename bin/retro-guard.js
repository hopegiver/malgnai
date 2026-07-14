#!/usr/bin/env node

/**
 * 회고 가드 — 마지막 회고 이후 새로운 claude 대화 활동이 있는지 + 최소 간격이 지났는지 판별.
 * 둘 다 만족하면 exit 0(회고 실행), 아니면 exit 1(skip → claude 호출 안 함 → 토큰 0).
 *
 * 트리거 소스: ~/.claude/projects/<projectKey>/<session>.jsonl 트랜스크립트의 mtime.
 * 마커: logs/last-retro.txt (마지막 회고 실행 시각, epoch ms).
 *
 * [07-03] sync-all.sh(10분 틱)에 얹혀 호출되므로, 예전처럼 cron 자체가 60분 간격을
 * 보장해주지 않는다 → RETRO_MIN_INTERVAL_MS(기본 60분)로 실제 회고 발동 빈도를 여기서 게이트.
 *
 * Usage: node bin/retro-guard.js   (종료 코드로 신호)
 */

import { readdirSync, statSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import os from "os"

const CLAUDE_DIR = process.env.CLAUDE_DIR || join(os.homedir(), ".claude")
const MARKER = join(process.cwd(), "logs", "last-retro.txt")
const MIN_INTERVAL_MS = parseInt(process.env.RETRO_MIN_INTERVAL_MS || "", 10) || 480 * 60 * 1000

// 마지막 회고 시각 (없으면 0 = 항상 회고거리 있음으로 간주)
function lastRetroAt() {
  if (!existsSync(MARKER)) return 0
  const n = parseInt(readFileSync(MARKER, "utf-8").trim(), 10)
  return Number.isFinite(n) ? n : 0
}

// 가장 최근에 수정된 트랜스크립트 mtime (epoch ms)
function latestTranscriptMtime() {
  const projectsDir = join(CLAUDE_DIR, "projects")
  if (!existsSync(projectsDir)) return 0
  let latest = 0
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (e.endsWith(".jsonl")) latest = Math.max(latest, st.mtimeMs)
    }
  }
  for (const proj of readdirSync(projectsDir)) {
    const pd = join(projectsDir, proj)
    if (statSync(pd).isDirectory()) walk(pd)
  }
  return latest
}

const since = lastRetroAt()
const latest = latestTranscriptMtime()
const elapsed = Date.now() - since

if (latest <= since) {
  console.log(`[retro-guard] no new activity since last retro → skip`)
  process.exit(1)
} else if (elapsed < MIN_INTERVAL_MS) {
  console.log(`[retro-guard] new activity but only ${Math.round(elapsed / 60000)}min since last retro (min ${Math.round(MIN_INTERVAL_MS / 60000)}min) → skip`)
  process.exit(1)
} else {
  console.log(`[retro-guard] new activity since last retro (latest=${new Date(latest).toISOString()}) and ${Math.round(elapsed / 60000)}min elapsed → run`)
  process.exit(0)
}
