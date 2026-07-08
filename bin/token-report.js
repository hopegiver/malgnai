#!/usr/bin/env node

/**
 * 토큰 사용 "토큰 도둑 색출" 리포트 — DB(claude_session_usage / claude_agent_usage)만 읽어
 * 거의 0토큰(로컬 SQL)으로 분석 출력. sync-claude.js 가 적재한 데이터를 소비한다.
 *
 * Usage:
 *   node bin/token-report.js [--since today|week|YYYY-MM-DD] [--limit N] [--project <key>]
 *   pnpm run token-report -- --since today
 */

import Database from "better-sqlite3"
import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// DB_PATH: env → .dev.vars → 기본값 (server/node.js 와 동일 규칙)
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH
  const dv = join(ROOT, ".dev.vars")
  if (existsSync(dv)) {
    const m = readFileSync(dv, "utf-8").match(/^DB_PATH=(.+)$/m)
    if (m) return m[1].trim()
  }
  return join(ROOT, "data", "malgnai.db")
}

// --- args ---
const args = process.argv.slice(2)
const getArg = (name, def = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const sinceArg = getArg("since")
const limit = Number(getArg("limit", "15"))
const projectFilter = getArg("project")

function resolveSince(v) {
  if (!v) return null
  const now = new Date()
  if (v === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  if (v === "week") return new Date(now.getTime() - 7 * 864e5).toISOString()
  return new Date(v).toISOString()
}
const since = resolveSince(sinceArg)

// --- helpers ---
const n = (x) => (x || 0).toLocaleString()
const usd = (x) => `$${(x || 0).toFixed(2)}`
const k = (x) => `${((x || 0) / 1000).toFixed(0)}K`
const pad = (s, w) => String(s).padEnd(w)
const rpad = (s, w) => String(s).padStart(w)
const shortKey = (key) => (key || "?").replace(/^-Users-[^-]+-workspace-/, "").replace(/^g--workspace-/, "").slice(0, 24)

const db = new Database(resolveDbPath(), { readonly: true, fileMustExist: true })
const W = (sql, ...b) => db.prepare(sql).get(...b)
const A = (sql, ...b) => db.prepare(sql).all(...b)

const sinceSql = since ? "WHERE started_at >= ?" : ""
const sinceBind = since ? [since] : []

console.log(`\n토큰 도둑 색출 리포트  (기간: ${sinceArg || "전체"}${since ? ` = ${since.slice(0, 16)} 이후` : ""})`)
console.log("=".repeat(72))

// 1) 전체 요약
const sum = W(
  `SELECT COUNT(*) sessions, SUM(total_tokens) tokens, SUM(cost_usd) cost,
          SUM(main_input+main_output+main_cache_read+main_cache_write_1h+main_cache_write_5m) main_tok,
          SUM(sub_input+sub_output+sub_cache_read+sub_cache_write_1h+sub_cache_write_5m) sub_tok,
          SUM(main_cache_write_1h+sub_cache_write_1h) cw1h,
          SUM(main_cache_read+sub_cache_read) cr
   FROM claude_session_usage ${sinceSql}`, ...sinceBind
)
const tot = sum?.tokens || 0
console.log(`세션 ${n(sum?.sessions)}개 | 총 ${n(tot)} 토큰 | 추정비용 ${usd(sum?.cost)}`)
if (tot) {
  console.log(`  메인 ${k(sum.main_tok)} (${(sum.main_tok/tot*100).toFixed(0)}%) · 서브에이전트 ${k(sum.sub_tok)} (${(sum.sub_tok/tot*100).toFixed(0)}%)`)
  console.log(`  캐시읽기 ${k(sum.cr)} (${(sum.cr/tot*100).toFixed(0)}%, 저렴) · 캐시쓰기1h ${k(sum.cw1h)} (2배 요금)`)
}

// 2) 세션 top-N (비용순)
console.log(`\n■ 세션 Top ${limit} (비용순)`)
console.log(`${pad("세션",9)} ${pad("프로젝트",18)} ${rpad("메인턴",6)} ${rpad("서브턴",6)} ${rpad("서브",4)} ${rpad("총토큰",13)} ${rpad("비용",9)}  제목`)
console.log("-".repeat(118))
const pf = projectFilter ? "AND project_key = ?" : ""
for (const s of A(
  `SELECT * FROM claude_session_usage ${since ? "WHERE started_at >= ?" : "WHERE 1=1"} ${pf}
   ORDER BY cost_usd DESC LIMIT ?`, ...sinceBind, ...(projectFilter ? [projectFilter] : []), limit
)) {
  console.log(
    `${pad(s.session_id.slice(0,8),9)} ${pad(shortKey(s.project_key),18)} ${rpad(s.main_turns,6)} ${rpad(s.sub_turns||0,6)} ${rpad(s.sub_agent_count||0,4)} ${rpad(n(s.total_tokens),13)} ${rpad(usd(s.cost_usd),9)}  ${(s.title||"").slice(0,30)}`
  )
}

// 3) 프로젝트별
console.log(`\n■ 프로젝트별`)
console.log(`${pad("프로젝트",26)} ${rpad("세션",5)} ${rpad("총토큰",14)} ${rpad("비용",9)}`)
console.log("-".repeat(58))
for (const p of A(
  `SELECT project_key, COUNT(*) sessions, SUM(total_tokens) tokens, SUM(cost_usd) cost
   FROM claude_session_usage ${sinceSql} GROUP BY project_key ORDER BY cost DESC LIMIT ?`,
  ...sinceBind, limit
)) {
  console.log(`${pad(shortKey(p.project_key),26)} ${rpad(p.sessions,5)} ${rpad(n(p.tokens),14)} ${rpad(usd(p.cost),9)}`)
}

// 4) 에이전트 type별
console.log(`\n■ 서브에이전트 type별 (도둑 색출)`)
console.log(`${pad("에이전트",18)} ${rpad("호출",5)} ${rpad("총턴",6)} ${rpad("최대턴",6)} ${rpad("토큰",13)} ${rpad("비용",9)}`)
console.log("-".repeat(64))
const aJoin = since ? "JOIN claude_session_usage s ON s.session_id=a.session_id AND s.started_at>=?" : ""
for (const a of A(
  `SELECT a.agent_type, SUM(a.invocations) inv, SUM(a.turns) turns, MAX(a.max_turns) maxt,
          SUM(a.tokens) tokens, SUM(a.cost_usd) cost
   FROM claude_agent_usage a ${aJoin}
   GROUP BY a.agent_type ORDER BY cost DESC LIMIT ?`, ...sinceBind, limit
)) {
  console.log(
    `${pad(a.agent_type||"unknown",18)} ${rpad(a.inv,5)} ${rpad(a.turns,6)} ${rpad(a.maxt,6)} ${rpad(n(a.tokens),13)} ${rpad(usd(a.cost),9)}`
  )
}

console.log()
db.close()
