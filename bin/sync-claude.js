#!/usr/bin/env node

/**
 * C:/Users/user/.claude 디렉토리의 데이터를 모니터링 서버에 동기화
 * - history.jsonl: 대화 히스토리
 * - stats-cache.json: 일별 사용 통계
 * - projects/[proj]/memory/ : 프로젝트별 메모리
 * - sessions/*.json: 세션 정보
 *
 * Usage: node bin/sync-claude.js [server-url]
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs"
import { join, basename } from "path"
import { createHash } from "crypto"

const CLAUDE_DIR = process.env.CLAUDE_DIR || "C:/Users/user/.claude"
const SERVER_URL = process.argv[2] || "http://localhost:9000"

// --- History ---
function readHistory() {
  const filePath = join(CLAUDE_DIR, "history.jsonl")
  if (!existsSync(filePath)) return []

  const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean)
  return lines.map((line, i) => {
    try {
      const obj = JSON.parse(line)
      return {
        id: createHash("md5").update(line).digest("hex"),
        display: (obj.display || "").slice(0, 500),
        project: obj.project || null,
        timestamp: obj.timestamp || 0,
        created_at: obj.timestamp ? new Date(obj.timestamp).toISOString() : new Date().toISOString(),
      }
    } catch { return null }
  }).filter(Boolean)
}

// --- Transcripts (일별 통계 + 토큰) ---
// 매일 갱신되는 진짜 소스는 projects/*/<session>.jsonl 트랜스크립트다.
// (history.jsonl / stats-cache.json은 과거 특정 시점에서 멈춘 레거시 파일.)
// 메시지별 timestamp·model·usage를 날짜별로 집계해 일별 통계와 토큰을 산출한다.

// 로컬 타임존 기준 YYYY-MM-DD
function localDate(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return null
  const off = d.getTimezoneOffset() * 60000
  return new Date(d - off).toISOString().slice(0, 10)
}

// 각 트랜스크립트 파일과, 그 파일이 속한 최상위 projects/<projectKey> 폴더명을 함께 반환
function listTranscripts() {
  const projectsDir = join(CLAUDE_DIR, "projects")
  if (!existsSync(projectsDir)) return []
  const files = []
  const walk = (dir, projectKey) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p, projectKey)
      else if (e.endsWith(".jsonl")) files.push({ file: p, projectKey })
    }
  }
  for (const proj of readdirSync(projectsDir)) {
    const pd = join(projectsDir, proj)
    if (statSync(pd).isDirectory()) walk(pd, proj)
  }
  return files
}

function readTranscripts() {
  // 날짜별 집계: { date: { messages, tools, sessions:Set, projects:Set, tokensByModel:{} } }
  const days = new Map()
  // 모델별 누적: { model: { input, output, cacheRead, cacheCreate } }
  const modelTotals = new Map()

  const getDay = (date) => {
    if (!days.has(date)) days.set(date, { messages: 0, tools: 0, sessions: new Set(), projects: new Set(), tokensByModel: {} })
    return days.get(date)
  }
  const getModel = (model) => {
    if (!modelTotals.has(model)) modelTotals.set(model, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
    return modelTotals.get(model)
  }

  for (const { file } of listTranscripts()) {
    let lines
    try { lines = readFileSync(file, "utf-8").split("\n") } catch { continue }
    for (const line of lines) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }

      const type = o.type
      if (type !== "user" && type !== "assistant") continue
      const date = localDate(o.timestamp)
      if (!date) continue

      const day = getDay(date)
      day.messages++
      if (o.sessionId) day.sessions.add(o.sessionId)
      if (o.cwd) day.projects.add(o.cwd)

      if (type === "assistant") {
        const msg = o.message || {}
        const model = msg.model || "unknown"
        // 도구 호출 수
        for (const b of msg.content || []) {
          if (b && b.type === "tool_use") day.tools++
        }
        // 토큰
        const u = msg.usage || {}
        const inT = u.input_tokens || 0
        const outT = u.output_tokens || 0
        const crT = u.cache_read_input_tokens || 0
        const ccT = u.cache_creation_input_tokens || 0
        const total = inT + outT + crT + ccT
        if (total > 0) {
          day.tokensByModel[model] = (day.tokensByModel[model] || 0) + total
          const mt = getModel(model)
          mt.input += inT; mt.output += outT; mt.cacheRead += crT; mt.cacheCreate += ccT
        }
      }
    }
  }

  // → sync payload
  const stats = []
  const tokens = []
  for (const [date, d] of days) {
    stats.push({
      id: `stats-${date}`,
      date,
      message_count: d.messages,
      session_count: d.sessions.size,
      tool_call_count: d.tools,
      project_count: d.projects.size,
    })
    for (const [model, t] of Object.entries(d.tokensByModel)) {
      tokens.push({ id: `tok-${date}-${model}`, date, model, tokens: t })
    }
  }

  const now = new Date().toISOString()
  const modelUsage = [...modelTotals].map(([model, m]) => ({
    model,
    input_tokens: m.input,
    output_tokens: m.output,
    cache_read_tokens: m.cacheRead,
    cache_creation_tokens: m.cacheCreate,
    updated_at: now,
  }))

  return { stats, tokens, modelUsage }
}

// --- Project Sessions (작업 이력) ---
// 트랜스크립트 1개 = 1 세션. 제목·첫/마지막 프롬프트·메시지수·시각을 뽑아 프로젝트별로 묶는다.
// IDE/훅이 사용자 메시지에 곁다리로 끼워 넣는 컨텍스트 블록(파일 오픈 알림 등) — 제목에 안 섞이게 제외.
const INJECTED_TAG_RE = /^<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder)>/
function userText(msg) {
  if (!msg) return ""
  const c = msg.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c
      .filter(b => b && b.type === "text" && !INJECTED_TAG_RE.test((b.text || "").trim()))
      .map(b => b.text || "").join(" ").trim()
  }
  return ""
}

// 작업 이력은 각 projects/<projectKey>/ 최상위의 .jsonl(메인 대화)만 본다.
// 하위 폴더(<sessionId>/subagents/…)의 서브에이전트 트랜스크립트는 제외.
function listMainTranscripts() {
  const projectsDir = join(CLAUDE_DIR, "projects")
  if (!existsSync(projectsDir)) return []
  const files = []
  for (const proj of readdirSync(projectsDir)) {
    const pd = join(projectsDir, proj)
    if (!statSync(pd).isDirectory()) continue
    for (const e of readdirSync(pd)) {
      if (!e.endsWith(".jsonl")) continue
      const p = join(pd, e)
      if (statSync(p).isFile()) files.push({ file: p, projectKey: proj })
    }
  }
  return files
}

function readProjectSessions() {
  const sessions = []
  for (const { file, projectKey } of listMainTranscripts()) {
    let lines
    try { lines = readFileSync(file, "utf-8").split("\n") } catch { continue }

    const sessionId = basename(file, ".jsonl")
    let title = "", firstPrompt = "", lastPrompt = ""
    let cwd = null, gitBranch = null
    let messageCount = 0, toolCount = 0
    let startedAt = null, endedAt = null

    for (const line of lines) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }

      switch (o.type) {
        case "ai-title":
          if (o.aiTitle) title = o.aiTitle
          break
        case "last-prompt":
          if (o.lastPrompt) lastPrompt = o.lastPrompt.slice(0, 500)
          break
        case "user":
        case "assistant": {
          if (o.isSidechain) break // 서브에이전트 인라인 기록은 제외
          messageCount++
          if (o.cwd) cwd = o.cwd
          if (o.gitBranch) gitBranch = o.gitBranch
          if (o.timestamp) {
            if (!startedAt || o.timestamp < startedAt) startedAt = o.timestamp
            if (!endedAt || o.timestamp > endedAt) endedAt = o.timestamp
          }
          if (o.type === "user" && !firstPrompt) {
            // 실제 사용자 입력만. userType 은 VSCode/헤드리스 모두 "external"로 찍혀 구분력이
            // 없다(진짜 프롬프트도 도구결과 캐리어도 동일) — promptSource==="sdk" 만 사람이
            // 실제로 제출한 프롬프트에 붙는다(도구결과·Stop hook feedback 등은 비어있음).
            if (o.promptSource === "sdk") {
              const t = userText(o.message)
              if (t) firstPrompt = t.slice(0, 500)
            }
          }
          if (o.type === "assistant") {
            for (const b of o.message?.content || []) {
              if (b && b.type === "tool_use") toolCount++
            }
          }
          break
        }
      }
    }

    // 대화 메시지가 하나도 없는 빈/메타 전용 트랜스크립트는 건너뜀
    if (messageCount === 0) continue

    sessions.push({
      id: sessionId,
      project_key: projectKey,
      cwd,
      git_branch: gitBranch,
      title: title || firstPrompt.slice(0, 80) || "",
      first_prompt: firstPrompt,
      last_prompt: lastPrompt || firstPrompt,
      message_count: messageCount,
      tool_count: toolCount,
      started_at: startedAt || null,
      ended_at: endedAt || null,
    })
  }
  return sessions
}

// --- Memories ---
function readMemories() {
  const projectsDir = join(CLAUDE_DIR, "projects")
  if (!existsSync(projectsDir)) return []

  const memories = []
  const projectDirs = readdirSync(projectsDir).filter(d => {
    const memDir = join(projectsDir, d, "memory")
    return existsSync(memDir) && statSync(memDir).isDirectory()
  })

  for (const projKey of projectDirs) {
    const memDir = join(projectsDir, projKey, "memory")
    const files = readdirSync(memDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md")

    for (const file of files) {
      const filePath = join(memDir, file)
      const raw = readFileSync(filePath, "utf-8")

      // frontmatter 파싱
      let name = "", description = "", type = ""
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/)
      if (fmMatch) {
        const fm = fmMatch[1]
        const nameMatch = fm.match(/name:\s*(.+)/)
        const descMatch = fm.match(/description:\s*(.+)/)
        const typeMatch = fm.match(/type:\s*(.+)/)
        if (nameMatch) name = nameMatch[1].trim()
        if (descMatch) description = descMatch[1].trim()
        if (typeMatch) type = typeMatch[1].trim()
      }

      // frontmatter 제거한 본문
      const content = raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim()

      memories.push({
        id: `mem-${projKey}-${basename(file, ".md")}`,
        project_key: projKey,
        file_name: file,
        name: name || basename(file, ".md"),
        description,
        type,
        content,
        updated_at: statSync(filePath).mtime.toISOString(),
      })
    }
  }

  return memories
}

// --- Sessions ---
function readSessions() {
  const sessDir = join(CLAUDE_DIR, "sessions")
  if (!existsSync(sessDir)) return []

  const files = readdirSync(sessDir).filter(f => f.endsWith(".json"))
  return files.map(f => {
    try {
      const data = JSON.parse(readFileSync(join(sessDir, f), "utf-8"))
      return {
        id: `sess-${data.pid || basename(f, ".json")}`,
        session_id: data.sessionId || null,
        pid: data.pid || null,
        cwd: data.cwd || null,
        kind: data.kind || null,
        entrypoint: data.entrypoint || null,
        started_at: data.startedAt ? new Date(data.startedAt).toISOString() : null,
      }
    } catch { return null }
  }).filter(Boolean)
}

// --- 비용 맵 (USD / 토큰). 모델별 단가. 캐시읽기=0.1배, 캐시쓰기 5m=1.25배·1h=2배. ---
const PRICING = {
  "claude-opus-4-8":   { in: 5e-6,  out: 25e-6, cr: 0.5e-6, cw1h: 10e-6, cw5m: 6.25e-6 },
  "claude-opus-4-7":   { in: 5e-6,  out: 25e-6, cr: 0.5e-6, cw1h: 10e-6, cw5m: 6.25e-6 },
  "claude-opus-4-6":   { in: 5e-6,  out: 25e-6, cr: 0.5e-6, cw1h: 10e-6, cw5m: 6.25e-6 },
  "claude-opus-4-5":   { in: 5e-6,  out: 25e-6, cr: 0.5e-6, cw1h: 10e-6, cw5m: 6.25e-6 },
  "claude-fable-5":    { in: 10e-6, out: 50e-6, cr: 1e-6,   cw1h: 20e-6, cw5m: 12.5e-6 },
  "claude-sonnet-5":   { in: 3e-6,  out: 15e-6, cr: 0.3e-6, cw1h: 6e-6,  cw5m: 3.75e-6 },
  "claude-sonnet-4-6": { in: 3e-6,  out: 15e-6, cr: 0.3e-6, cw1h: 6e-6,  cw5m: 3.75e-6 },
  "claude-haiku-4-5":  { in: 1e-6,  out: 5e-6,  cr: 0.1e-6, cw1h: 2e-6,  cw5m: 1.25e-6 },
}
const DEFAULT_PRICE = PRICING["claude-opus-4-8"]
function priceFor(model) {
  if (!model) return DEFAULT_PRICE
  for (const k of Object.keys(PRICING)) if (model.includes(k)) return PRICING[k]
  if (model.includes("opus")) return PRICING["claude-opus-4-8"]
  if (model.includes("sonnet")) return PRICING["claude-sonnet-5"]
  if (model.includes("haiku")) return PRICING["claude-haiku-4-5"]
  return DEFAULT_PRICE
}
// usage 객체에서 5개 토큰 항목 추출 (캐시쓰기는 1h/5m 분리)
function extractTokens(u) {
  const cc = u.cache_creation || {}
  return {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cr: u.cache_read_input_tokens || 0,
    // cache_creation 세부(1h/5m)가 있으면 그걸, 없으면 합계를 5m로 간주
    cw1h: cc.ephemeral_1h_input_tokens || 0,
    cw5m: cc.ephemeral_5m_input_tokens != null
      ? cc.ephemeral_5m_input_tokens
      : (cc.ephemeral_1h_input_tokens == null ? (u.cache_creation_input_tokens || 0) : 0),
  }
}
function costOf(model, t) {
  const p = priceFor(model)
  return t.in*p.in + t.out*p.out + t.cr*p.cr + t.cw1h*p.cw1h + t.cw5m*p.cw5m
}

// --- Session Usage (도둑 색출): 세션별 토큰/비용, main vs 서브에이전트 분리, 에이전트 type별 집계 ---
// 근거: 사이드체인(서브에이전트) 메시지는 부모와 같은 sessionId를 가지며 isSidechain=true + agentId 보유.
// agent_type 연결: Agent tool_use(id, input.subagent_type) → 같은 tool_use_id 의 tool_result(agentId) → agentId.
function readSessionUsage() {
  const S = new Map() // sessionId -> 세션 집계
  const blankTok = () => ({ in:0, out:0, cr:0, cw1h:0, cw5m:0 })
  const getS = (sid) => {
    if (!S.has(sid)) S.set(sid, {
      projectKey: null, cwd: null, gitBranch: null, title: "",
      firstPrompt: "",
      mainModels: {}, main: blankTok(), mainTurns: 0, mainCost: 0,
      sub: blankTok(), subTurns: 0, subCost: 0,
      byAgentId: new Map(),                 // agentId -> {turns, cost, tok}
      promptToType: new Map(),              // promptKey -> subagent_type (부모의 Agent tool_use)
      agentPrompt: new Map(),               // agentId -> promptKey (서브에이전트 root 프롬프트)
      started: null, ended: null,
    })
    return S.get(sid)
  }
  const addTok = (dst, t) => { dst.in+=t.in; dst.out+=t.out; dst.cr+=t.cr; dst.cw1h+=t.cw1h; dst.cw5m+=t.cw5m }
  // 프롬프트 조인키: Agent tool_use.input.prompt 와 서브에이전트 root 메시지가 동일 텍스트.
  const pkey = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 300)

  for (const { file, projectKey } of listTranscripts()) {
    let lines
    try { lines = readFileSync(file, "utf-8").split("\n") } catch { continue }
    for (const line of lines) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      const sid = o.sessionId
      if (!sid) continue

      if (o.type === "ai-title" && o.aiTitle) { getS(sid).title = o.aiTitle; continue }
      if (o.type !== "user" && o.type !== "assistant") continue

      const s = getS(sid)
      if (!s.projectKey) s.projectKey = projectKey
      if (o.cwd) s.cwd = o.cwd
      if (o.gitBranch) s.gitBranch = o.gitBranch
      if (o.timestamp) {
        if (!s.started || o.timestamp < s.started) s.started = o.timestamp
        if (!s.ended || o.timestamp > s.ended) s.ended = o.timestamp
      }
      if (o.type === "user" && !o.isSidechain && !s.firstPrompt && o.promptSource === "sdk") {
        const t = userText(o.message)
        if (t) s.firstPrompt = t.slice(0, 200)
      }
      // 서브에이전트 초기 프롬프트 → agentId별 프롬프트키(type 연결용).
      // agentId 첫 등장 = 그 서브에이전트의 시작 프롬프트(중첩 서브에이전트는 parentUuid≠null 이라
      // parentUuid=null 조건 대신 "첫 등장 + 텍스트 있음"으로 잡는다).
      if (o.type === "user" && o.isSidechain && o.agentId && !s.agentPrompt.has(o.agentId)) {
        const t = pkey(userText(o.message))
        if (t) s.agentPrompt.set(o.agentId, t)
      }
      if (o.type !== "assistant") continue

      const msg = o.message || {}
      const model = msg.model || "unknown"
      // 부모의 Agent/Task tool_use: input.prompt 로 subagent_type 를 기억(프롬프트 매칭 조인)
      for (const b of msg.content || []) {
        if (!b || typeof b !== "object") continue
        if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")
            && b.input?.subagent_type && b.input?.prompt) {
          s.promptToType.set(pkey(b.input.prompt), b.input.subagent_type)
        }
      }

      const u = msg.usage
      if (!u) continue
      const tok = extractTokens(u)
      const c = costOf(model, tok)
      if (o.isSidechain) {
        addTok(s.sub, tok); s.subTurns++; s.subCost += c
        const aid = o.agentId || "unknown"
        if (!s.byAgentId.has(aid)) s.byAgentId.set(aid, { turns: 0, cost: 0, tok: 0 })
        const a = s.byAgentId.get(aid)
        a.turns++; a.cost += c; a.tok += (tok.in+tok.out+tok.cr+tok.cw1h+tok.cw5m)
      } else {
        addTok(s.main, tok); s.mainTurns++; s.mainCost += c
        s.mainModels[model] = (s.mainModels[model] || 0) + 1
      }
    }
  }

  // → payload
  const sessionUsage = []
  const agentUsage = []
  for (const [sid, s] of S) {
    if (s.mainTurns === 0 && s.subTurns === 0) continue
    const model = Object.entries(s.mainModels).sort((a,b)=>b[1]-a[1])[0]?.[0] || "unknown"
    const total = ["in","out","cr","cw1h","cw5m"].reduce((n,k)=>n + s.main[k] + s.sub[k], 0)
    sessionUsage.push({
      session_id: sid, project_key: s.projectKey || "unknown",
      cwd: s.cwd, git_branch: s.gitBranch,
      title: s.title || s.firstPrompt.slice(0, 80) || "",
      model,
      main_turns: s.mainTurns, main_input: s.main.in, main_output: s.main.out,
      main_cache_read: s.main.cr, main_cache_write_1h: s.main.cw1h, main_cache_write_5m: s.main.cw5m,
      sub_turns: s.subTurns, sub_input: s.sub.in, sub_output: s.sub.out,
      sub_cache_read: s.sub.cr, sub_cache_write_1h: s.sub.cw1h, sub_cache_write_5m: s.sub.cw5m,
      sub_agent_count: s.byAgentId.size,
      total_tokens: total, cost_usd: +(s.mainCost + s.subCost).toFixed(6),
      started_at: s.started, ended_at: s.ended,
    })

    // agentId → subagent_type 합성(프롬프트키 매칭) 후 type별 롤업
    const agentIdType = new Map()
    for (const [aid, pk] of s.agentPrompt) {
      const type = s.promptToType.get(pk)
      if (type) agentIdType.set(aid, type)
    }
    const byType = new Map() // type -> {inv, turns, maxTurns, tokens, cost}
    for (const [aid, a] of s.byAgentId) {
      const type = agentIdType.get(aid) || "unknown"
      if (!byType.has(type)) byType.set(type, { inv:0, turns:0, maxTurns:0, tokens:0, cost:0 })
      const g = byType.get(type)
      g.inv++; g.turns += a.turns; g.tokens += a.tok; g.cost += a.cost
      if (a.turns > g.maxTurns) g.maxTurns = a.turns
    }
    const now = new Date().toISOString()
    for (const [type, g] of byType) {
      agentUsage.push({
        id: `au-${sid}-${type}`, session_id: sid, project_key: s.projectKey || "unknown",
        agent_type: type, invocations: g.inv, turns: g.turns, max_turns: g.maxTurns,
        tokens: g.tokens, cost_usd: +g.cost.toFixed(6), updated_at: now,
      })
    }
  }
  return { sessionUsage, agentUsage }
}

// --- Sync Helper ---
async function syncData(endpoint, items, label) {
  if (!items.length) {
    console.log(`  [${label}] 0 items — skip`)
    return 0
  }

  const res = await fetch(`${SERVER_URL}/api/claude/sync/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  })

  if (!res.ok) {
    console.error(`  [${label}] Failed: ${res.status} ${await res.text()}`)
    return 0
  }

  const data = await res.json()
  console.log(`  [${label}] ${data.synced} items synced`)
  return data.synced
}

// --- Main ---
async function main() {
  console.log(`[sync-claude] Reading from ${CLAUDE_DIR}`)
  console.log()

  const history = readHistory()
  console.log(`  History: ${history.length} entries`)

  const { stats, tokens, modelUsage } = readTranscripts()
  console.log(`  Stats: ${stats.length} days (from transcripts)`)
  console.log(`  Token stats: ${tokens.length} day-model rows, ${modelUsage.length} models`)

  const memories = readMemories()
  console.log(`  Memories: ${memories.length} files across ${new Set(memories.map(m => m.project_key)).size} projects`)

  const sessions = readSessions()
  console.log(`  Sessions: ${sessions.length} entries`)

  const projectSessions = readProjectSessions()
  console.log(`  Project sessions: ${projectSessions.length} across ${new Set(projectSessions.map(s => s.project_key)).size} projects`)

  const { sessionUsage, agentUsage } = readSessionUsage()
  console.log(`  Session usage: ${sessionUsage.length} sessions, ${agentUsage.length} agent-type rows`)

  console.log()
  console.log(`[sync-claude] Syncing to ${SERVER_URL}...`)

  await syncData("history", history, "history")
  await syncData("stats", stats, "stats")
  await syncData("tokens", tokens, "tokens")
  await syncData("model-usage", modelUsage, "model-usage")
  await syncData("memories", memories, "memories")
  await syncData("sessions", sessions, "sessions")
  await syncData("project-sessions", projectSessions, "project-sessions")
  await syncData("session-usage", sessionUsage, "session-usage")
  await syncData("agent-usage", agentUsage, "agent-usage")

  console.log()
  console.log("[sync-claude] Done!")
}

main().catch(e => { console.error(e); process.exit(1) })
