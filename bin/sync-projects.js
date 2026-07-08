#!/usr/bin/env node

/**
 * g:\workspace 폴더를 스캔하여 모니터링 서버에 프로젝트 동기화
 * Usage: node bin/sync-projects.js [server-url]
 */

import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"

// OS 무관 기본 워크스페이스 경로. 맥/리눅스=~/workspace, (구)윈도우=WORKSPACE_DIR 명시.
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || join(homedir(), "workspace")
const SERVER_URL = process.env.MALGNAI_SERVER_URL || process.argv[2] || "http://localhost:9000"

// 인입 경로 인증: MALGNAI_API_KEY 설정 시 X-API-Key 헤더를 함께 전송
function ingestHeaders() {
  const h = { "Content-Type": "application/json" }
  if (process.env.MALGNAI_API_KEY) h["X-API-Key"] = process.env.MALGNAI_API_KEY
  return h
}

// 제외할 폴더 패턴
const EXCLUDES = new Set(["node_modules", ".git", "old", ".cache", ".tmp"])

// .claude/project.json — 안정적 신원 메타(id/name/description/kind). 있으면 이걸 우선 신뢰한다
// (package.json/CLAUDE.md 정규식 스크래핑보다 안정적). 파싱 실패(손상 JSON)면 없는 것으로 취급.
function readProjectJson(dirPath) {
  const p = join(dirPath, ".claude", "project.json")
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, "utf-8")) } catch { return null }
}

// project.json 이 없을 때, 지금 파악한 값으로 하나 만들어둔다(다음 sync부터는 이걸 우선 사용).
// 쓰기 실패(권한 등)는 무시 — 다음 sync 때 재시도된다.
function writeProjectJson(dirPath, meta) {
  try {
    mkdirSync(join(dirPath, ".claude"), { recursive: true })
    writeFileSync(join(dirPath, ".claude", "project.json"), JSON.stringify({
      _help: "안정적 프로젝트 신원 메타데이터(생성 시 고정, 거의 안 바뀜). STATUS.md는 사람이 읽는 라이브 서술이고, 이 파일은 sync-projects.js 등이 읽는 머신 필드다. autonomy_enabled·cadence·lead_agent_name·status(라이프사이클)처럼 웹 UI로 실시간 바뀌는 값은 DB가 정본이므로 여기 넣지 않는다.",
      ...meta,
    }, null, 2) + "\n", "utf-8")
  } catch { /* ignore — 다음 sync 때 재시도 */ }
}

function scanProject(dirPath) {
  const name = basename(dirPath)
  const stat = statSync(dirPath)
  if (!stat.isDirectory()) return null

  const projectJson = readProjectJson(dirPath)

  // package.json에서 설명 추출
  let description = ""
  const pkgPath = join(dirPath, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
      description = pkg.description || ""
    } catch { /* ignore */ }
  }

  // CLAUDE.md에서 프로젝트 설명 추출 (우선)
  const claudeMdPath = join(dirPath, "CLAUDE.md")
  if (existsSync(claudeMdPath)) {
    try {
      const md = readFileSync(claudeMdPath, "utf-8")
      // "## Project Overview" 또는 첫 번째 설명 라인 추출
      const overviewMatch = md.match(/##\s*Project Overview\s*\n+\*\*.*?\*\*\s*[—–-]\s*(.+)/i)
      if (overviewMatch) description = overviewMatch[1].trim()
    } catch { /* ignore */ }
  }

  // project.json 이 있으면 description/kind 는 그 값을 최종 우선한다(정규식 스크래핑보다 신뢰).
  const kind = projectJson?.kind
  if (projectJson?.description) description = projectJson.description

  // id: project.json 우선. 없으면 STATUS.md 헤더의 레거시 주석(그대로 유지되는 소스)에서 폴백.
  // 서버 upsert 가 신규 생성 시 이 id 를 그대로 써서(재생성해도 결정적) 기록 링크 단절을 막는다.
  // 값이 백틱/따옴표로 감싸진 경우(`<id>`, "<id>")도 허용한다.
  let id = projectJson?.id ?? null
  const statusPath = join(dirPath, "STATUS.md")
  if (!id && existsSync(statusPath)) {
    try {
      const m = readFileSync(statusPath, "utf-8")
        .match(/malgnai-mcp\s+project_id:\s*["'`]?\s*([0-9a-fA-F-]{8,})/)
      if (m) id = m[1]
    } catch { /* ignore */ }
  }

  // project.json 이 아직 없으면 지금 파악한 값으로 하나 만들어 다음 sync부터 이걸 신뢰하게 한다.
  if (!projectJson && id) {
    writeProjectJson(dirPath, { id, name, description, kind: kind || "dev", created_at: new Date().toISOString() })
  }

  return {
    id,
    name,
    description,
    kind,
    // status(라이프사이클: 대기/진행/완료/보류/삭제)는 **사람/AI의 명시적 선언**으로만 바꾼다.
    // 과거엔 여기서 `.git 유무 → active/pending`으로 매 sync마다 덮어써(10분마다 강제 active)
    //   "진행중" 배지가 실제 진행과 무관해지는 근본원인이었다. 이제 sync는 status를 보내지 않는다
    //   → upsert가 기존값 보존(신규 프로젝트는 서버 create 기본값 'pending'). "지금 돌고 있나"는
    //   서버가 파생하는 activity_status(가동중/대기/점검/정지)로 표현한다. status='deleted' 전이는
    //   서버(/api/projects/sync)가 "이번 스캔에 없는 폴더" 를 판단해 별도로 처리한다.
    path: dirPath.replace(/\\/g, "/"),
    // "최근 업데이트" = 폴더 내 최상위 항목들의 최신 수정 시각. 동기화 시각이 아니라
    // 실제 작업 시각으로 정렬되도록 서버에 함께 전달한다(upsert가 보존).
    updated_at: latestMtime(dirPath),
  }
}

// 폴더 최상위 항목들(파일/하위폴더) 중 가장 최근 mtime을 ISO 문자열로 반환.
// node_modules/.git 등 잡음 폴더는 제외. 비면 폴더 자체 mtime.
function latestMtime(dirPath) {
  let latest = 0
  try {
    for (const e of readdirSync(dirPath)) {
      if (EXCLUDES.has(e)) continue
      try {
        const m = statSync(join(dirPath, e)).mtimeMs
        if (m > latest) latest = m
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  if (!latest) {
    try { latest = statSync(dirPath).mtimeMs } catch { /* ignore */ }
  }
  return latest ? new Date(latest).toISOString() : new Date().toISOString()
}

async function main() {
  const entries = readdirSync(WORKSPACE_DIR)
  const projects = entries
    .filter(e => !EXCLUDES.has(e) && !e.startsWith("."))
    .map(e => scanProject(join(WORKSPACE_DIR, e)))
    .filter(Boolean)

  console.log(`[sync-projects] ${projects.length} projects found in ${WORKSPACE_DIR}`)
  for (const p of projects) {
    console.log(`  ${p.name.padEnd(25)} ${p.description.slice(0, 50) || "-"}`)
  }

  const res = await fetch(`${SERVER_URL}/api/projects/sync`, {
    method: "POST",
    headers: ingestHeaders(),
    body: JSON.stringify({ projects, workspace_dir: WORKSPACE_DIR.replace(/\\/g, "/") }),
  })

  if (!res.ok) {
    console.error(`[sync-projects] Failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }

  const data = await res.json()
  console.log(`\n[sync-projects] ${data.synced} projects synced to ${SERVER_URL}`)
  if (data.deleted?.length) {
    console.log(`[sync-projects] ${data.deleted.length} projects marked deleted (폴더 소실): ${data.deleted.join(", ")}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
