#!/usr/bin/env node

/**
 * 실시간 Claude 세션 감시 데몬
 * - .claude/projects/**​/*.jsonl 파일 변경 감시
 * - 증분 파싱 (마지막 offset부터)
 * - 토큰/메시지 집계
 * - API로 DB 동기화
 *
 * Usage: node bin/watch-claude.js [server-url]
 * LaunchAgent로 상시 실행됨
 */

import { readFileSync, existsSync, statSync, writeFileSync, readdirSync } from "fs"
import { join, basename } from "path"
import { createHash } from "crypto"
import chokidar from "chokidar"

const CLAUDE_DIR = process.env.CLAUDE_DIR || (process.env.HOME ? `${process.env.HOME}/.claude` : "~/.claude")
const SERVER_URL = process.argv[2] || "http://localhost:9000"
const WATCH_STATE_FILE = "data/claude-watch.json"
const DEBOUNCE_MS = 1000 // 파일 변경 후 1초 대기 (빠른 연속 변경 배치)

// 로컬 타임존 기준 YYYY-MM-DD
function localDate(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return null
  const off = d.getTimezoneOffset() * 60000
  return new Date(d - off).toISOString().slice(0, 10)
}

// 사용자 입력만 추출 (IDE 주입 태그 제외)
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

// 비용 계산
const PRICING = {
  "claude-opus-4-8":   { in: 5e-6,  out: 25e-6, cr: 0.5e-6, cw1h: 10e-6, cw5m: 6.25e-6 },
  "claude-opus-4-7":   { in: 5e-6,  out: 25e-6, cr: 0.5e-6, cw1h: 10e-6, cw5m: 6.25e-6 },
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

function extractTokens(u) {
  const cc = u.cache_creation || {}
  return {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cr: u.cache_read_input_tokens || 0,
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

// --- State 관리 ---
class WatchState {
  constructor(filePath) {
    this.filePath = filePath
    this.state = this.load()
  }

  load() {
    if (existsSync(this.filePath)) {
      try {
        return JSON.parse(readFileSync(this.filePath, "utf-8"))
      } catch (e) {
        console.error(`[watch] Failed to load state: ${e.message}`)
      }
    }
    return { files: {} } // { filename: { lastLineNum, lastMtime, sessionId, ... } }
  }

  save() {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8")
    } catch (e) {
      console.error(`[watch] Failed to save state: ${e.message}`)
    }
  }

  getFileState(filename) {
    return this.state.files[filename] || {}
  }

  updateFileState(filename, data) {
    this.state.files[filename] = { ...this.state.files[filename], ...data }
    this.save()
  }
}

// --- 증분 파싱 ---
function parseIncrementalLines(filePath, lastLineNum = 0) {
  try {
    const content = readFileSync(filePath, "utf-8")
    const lines = content.split("\n")
    const mtime = statSync(filePath).mtimeMs

    const newLines = []
    for (let i = lastLineNum; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        newLines.push({ lineNum: i, obj })
      } catch (e) {
        console.warn(`[watch] Parse error at ${basename(filePath)}:${i+1}: ${e.message}`)
      }
    }

    return { newLines, mtime, totalLines: lines.length }
  } catch (e) {
    console.error(`[watch] Read error ${filePath}: ${e.message}`)
    return { newLines: [], mtime: 0, totalLines: 0 }
  }
}

// --- 프로젝트 Key 추출 (projectDir/.claude/projects/KEY/...)
function extractProjectKey(filePath) {
  const projectsIdx = filePath.indexOf("/.claude/projects/")
  if (projectsIdx === -1) return null
  const afterProjects = filePath.slice(projectsIdx + "/.claude/projects/".length)
  const parts = afterProjects.split("/")
  return parts[0] || null
}

// --- 증분 집계 (session별 토큰/메시지)
function aggregateIncremental(filePath, newLines, projectKey) {
  const sessionId = basename(filePath, ".jsonl")

  let title = ""
  let firstPrompt = ""
  let lastPrompt = ""
  let cwd = null
  let gitBranch = null
  let messageCount = 0
  let toolCount = 0
  let startedAt = null
  let endedAt = null

  const tokens = { in: 0, out: 0, cr: 0, cw1h: 0, cw5m: 0 }
  let model = "unknown"
  let cost = 0

  for (const { obj } of newLines) {
    const type = obj.type

    if (type === "ai-title" && obj.aiTitle) {
      title = obj.aiTitle
      continue
    }

    if (type === "last-prompt" && obj.lastPrompt) {
      lastPrompt = obj.lastPrompt.slice(0, 500)
      continue
    }

    if (type !== "user" && type !== "assistant") continue

    if (obj.isSidechain) continue // 서브에이전트 인라인 기록 제외

    messageCount++
    if (obj.cwd) cwd = obj.cwd
    if (obj.gitBranch) gitBranch = obj.gitBranch
    if (obj.timestamp) {
      const ts = obj.timestamp
      if (!startedAt || ts < startedAt) startedAt = ts
      if (!endedAt || ts > endedAt) endedAt = ts
    }

    if (type === "user" && !firstPrompt && obj.promptSource === "sdk") {
      const t = userText(obj.message)
      if (t) firstPrompt = t.slice(0, 500)
    }

    if (type === "assistant") {
      const msg = obj.message || {}
      model = msg.model || model

      // 도구 호출
      for (const b of msg.content || []) {
        if (b && b.type === "tool_use") toolCount++
      }

      // 토큰 계산
      const u = msg.usage
      if (u) {
        const t = extractTokens(u)
        tokens.in += t.in
        tokens.out += t.out
        tokens.cr += t.cr
        tokens.cw1h += t.cw1h
        tokens.cw5m += t.cw5m
        cost += costOf(model, t)
      }
    }
  }

  const totalTokens = tokens.in + tokens.out + tokens.cr + tokens.cw1h + tokens.cw5m

  return {
    session_id: sessionId,
    project_key: projectKey || "unknown",
    cwd,
    git_branch: gitBranch,
    title: title || firstPrompt.slice(0, 80) || "",
    first_prompt: firstPrompt,
    last_prompt: lastPrompt || firstPrompt,
    message_count: messageCount,
    tool_count: toolCount,
    model,
    main_input: tokens.in,
    main_output: tokens.out,
    main_cache_read: tokens.cr,
    main_cache_write_1h: tokens.cw1h,
    main_cache_write_5m: tokens.cw5m,
    total_tokens: totalTokens,
    cost_usd: +(cost).toFixed(6),
    started_at: startedAt,
    ended_at: endedAt,
  }
}

// --- API 호출 ---
async function syncIncremental(data) {
  if (!data || !data.sessions || data.sessions.length === 0) return 0

  try {
    const res = await fetch(`${SERVER_URL}/api/claude/sync/incremental`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: data.sessions }),
    })

    if (!res.ok) {
      console.error(`[watch] Sync failed: ${res.status} ${await res.text()}`)
      return 0
    }

    const result = await res.json()
    return result.synced || 0
  } catch (e) {
    console.error(`[watch] API error: ${e.message}`)
    return 0
  }
}

// --- 메인 감시 루프 ---
async function main() {
  console.log(`[watch-claude] Starting file watcher...`)
  console.log(`  Claude dir: ${CLAUDE_DIR}`)
  console.log(`  Server: ${SERVER_URL}`)
  console.log(`  State: ${WATCH_STATE_FILE}`)
  console.log()

  const state = new WatchState(WATCH_STATE_FILE)
  const projectsDir = join(CLAUDE_DIR, "projects")

  if (!existsSync(projectsDir)) {
    console.log(`[watch] Projects dir not found: ${projectsDir}, waiting...`)
    // 디렉토리가 생길 때까지 대기하지 말고, 정상 종료
    process.exit(0)
  }

  let isProcessing = false
  const POLL_INTERVAL_MS = 5000 // 5초 주기 폴링

  let checkCount = 0
  const checkFiles = async () => {
    if (isProcessing) return
    isProcessing = true
    checkCount++

    try {
      const sessions = []

      // 모든 .jsonl 파일 스캔
      const getAllJsonlFiles = (dir) => {
        const files = []
        try {
          const entries = readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = join(dir, entry.name)
            if (entry.isDirectory()) {
              files.push(...getAllJsonlFiles(fullPath))
            } else if (entry.name.endsWith(".jsonl")) {
              files.push(fullPath)
            }
          }
        } catch (e) {
          // 권한 문제 등 무시
        }
        return files
      }

      const allFiles = getAllJsonlFiles(projectsDir)
      if (checkCount % 3 === 1) console.log(`[watch:poll] Scan #${checkCount}: found ${allFiles.length} files`)

      let changedCount = 0
      for (const filePath of allFiles) {
        const projectKey = extractProjectKey(filePath)
        if (!projectKey) continue

        const fileState = state.getFileState(filePath)
        const lastLineNum = fileState.lastLineNum || 0
        const lastMtime = fileState.lastMtime || 0

        // mtime 확인 (변경 감지)
        let mtime = 0
        try {
          mtime = statSync(filePath).mtimeMs
        } catch {
          continue
        }

        // 변경되지 않았으면 스킵
        if (mtime <= lastMtime) continue

        const { newLines, mtime: newMtime, totalLines } = parseIncrementalLines(filePath, lastLineNum)

        if (newLines.length > 0) {
          const sessionData = aggregateIncremental(filePath, newLines, projectKey)
          sessions.push(sessionData)

          console.log(`[watch] Updated ${basename(filePath)}: +${newLines.length} lines (msg=${sessionData.message_count}, tokens=${sessionData.total_tokens})`)

          state.updateFileState(filePath, {
            lastLineNum: totalLines,
            lastMtime: newMtime,
            lastSyncAt: new Date().toISOString(),
          })
        }
      }

      if (sessions.length > 0) {
        const synced = await syncIncremental({ sessions })
        console.log(`[watch] Synced ${synced} sessions to DB`)
      }
    } catch (e) {
      console.error(`[watch] Check error: ${e.message}`)
    } finally {
      isProcessing = false
    }
  }

  // 폴링 루프 시작
  console.log(`[watch] Watching for changes in ${projectsDir}`)
  console.log(`[watch] Poll interval: ${POLL_INTERVAL_MS}ms`)
  console.log(`[watch] Ready. Daemon started (PID ${process.pid})`)

  // 상태 파일 초기화
  state.save()

  // 주기적 폴링
  setInterval(checkFiles, POLL_INTERVAL_MS)

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log(`[watch] SIGTERM received, shutting down...`)
    process.exit(0)
  })

  process.on("SIGINT", () => {
    console.log(`[watch] SIGINT received, shutting down...`)
    process.exit(0)
  })

  // Uncaught exception handler
  process.on("uncaughtException", (err) => {
    console.error(`[watch] Uncaught exception: ${err.message}`)
    console.error(err.stack)
    process.exit(1)
  })

  process.on("unhandledRejection", (reason, promise) => {
    console.error(`[watch] Unhandled rejection at ${promise}: ${reason}`)
    process.exit(1)
  })
}

main().catch(e => {
  console.error(`[watch] Fatal error: ${e.message}`)
  console.error(e.stack)
  process.exit(1)
})
