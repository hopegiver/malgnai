#!/usr/bin/env node

/**
 * .claude/agents/*.md 파일을 읽어서 모니터링 서버에 동기화
 * 역할별 스킬 정의 + MD 파일 기반 수준 평가 포함
 * Usage: node bin/sync-agents.js [server-url]
 */

import { readdirSync, readFileSync, existsSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"
import { createHash } from "crypto"
import { SKILL_DEFINITIONS, TEAM_DEFINITIONS, KNOWLEDGE_MAP, EMPLOYEE_CARDS, DEFAULT_EMPLOYEE_CARD, assessSkillLevel } from "./skill-definitions.js"

const AGENTS_DIR = process.env.AGENTS_DIR || join(homedir(), ".claude", "agents")
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || join(homedir(), ".claude", "knowledge")
const SERVER_URL = process.argv[2] || "http://localhost:9000"

/**
 * md 파일에서 제목(첫 # h1)과 요약(첫 본문 문단/표 외 텍스트) 추출
 */
function extractMeta(raw) {
  const lines = raw.split(/\r?\n/)
  let title = ""
  let summary = ""
  for (const line of lines) {
    const t = line.trim()
    if (!title && t.startsWith("# ")) { title = t.replace(/^#\s+/, "").trim(); continue }
    if (title && !summary && t && !t.startsWith("#") && !t.startsWith("|") && !t.startsWith("```") && !t.startsWith("-") && !t.startsWith(">")) {
      summary = t.replace(/[*_`]/g, "")
      break
    }
  }
  return { title, summary }
}

/**
 * 에이전트에 매핑된 knowledge 폴더의 md 목록을 {folder, file, title, summary}로 수집
 */
function collectKnowledge(agentName) {
  const folders = KNOWLEDGE_MAP[agentName] || []
  const items = []
  for (const folder of folders) {
    const dir = join(KNOWLEDGE_DIR, folder)
    if (!existsSync(dir)) continue
    const files = readdirSync(dir).filter(f => f.endsWith(".md"))
    for (const f of files) {
      const raw = readFileSync(join(dir, f), "utf-8")
      const { title, summary } = extractMeta(raw)
      items.push({ folder, file: f, title: title || f.replace(/\.md$/, ""), summary, content: raw })
    }
  }
  return items
}

function parseMd(filePath) {
  const raw = readFileSync(filePath, "utf-8")
  const hash = createHash("md5").update(raw).digest("hex")
  const name = basename(filePath, ".md")

  let role = name
  let description = ""
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    const fm = fmMatch[1]
    const descMatch = fm.match(/description:\s*(.+)/)
    if (descMatch) description = descMatch[1].trim()
    const nameMatch = fm.match(/name:\s*(.+)/)
    if (nameMatch) role = nameMatch[1].trim()
  }

  // 스킬 정의에서 해당 에이전트의 스킬을 가져와 수준 평가
  const skillDef = SKILL_DEFINITIONS[name]
  let skills = []
  let team = null
  let avgLevel = 1

  if (skillDef) {
    team = skillDef.team
    skills = skillDef.skills.map(s => ({
      ...s,
      level: assessSkillLevel(raw, s),
      maxLevel: 5,
    }))
    avgLevel = Math.round(skills.reduce((sum, s) => sum + s.level, 0) / skills.length)
  }

  const levelMap = { 1: "beginner", 2: "beginner", 3: "intermediate", 4: "advanced", 5: "expert" }

  const knowledge = collectKnowledge(name)

  // B-2 AI 직원 카드 메타 주입. job_title 은 SKILL_DEFINITIONS.title 재사용.
  const card = EMPLOYEE_CARDS[name] || DEFAULT_EMPLOYEE_CARD
  const job_title = (skillDef && skillDef.title) || role

  return {
    name,
    role,
    description,
    status: "active",
    md_content: raw,
    md_hash: hash,
    skills: JSON.stringify(skills),
    skill_level: levelMap[avgLevel] || "beginner",
    team,
    knowledge: JSON.stringify(knowledge),
    job_title,
    model: card.model,
    forbidden_tasks: JSON.stringify(card.forbidden_tasks || []),
    approval_required_tasks: JSON.stringify(card.approval_required_tasks || []),
  }
}

async function main() {
  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md"))
  const agents = files.map(f => parseMd(join(AGENTS_DIR, f)))

  console.log(`[sync] ${agents.length} agents found in ${AGENTS_DIR}`)
  console.log()

  // 팀별로 그룹핑하여 출력
  for (const [teamId, teamDef] of Object.entries(TEAM_DEFINITIONS)) {
    const members = agents.filter(a => a.team === teamId)
    if (!members.length) continue
    console.log(`  [${teamDef.name}] ${teamDef.description}`)
    for (const a of members) {
      const skills = JSON.parse(a.skills)
      const avg = skills.length ? (skills.reduce((s, sk) => s + sk.level, 0) / skills.length).toFixed(1) : "0"
      const knCount = JSON.parse(a.knowledge || "[]").length
      console.log(`    ${a.name.padEnd(18)} Lv${avg}/5  (${skills.length} skills, ${knCount} 학습자료)`)
    }
    console.log()
  }

  const res = await fetch(`${SERVER_URL}/api/agents/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agents }),
  })

  if (!res.ok) {
    console.error(`[sync] Failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }

  const data = await res.json()
  console.log(`[sync] ${data.synced} agents synced to ${SERVER_URL}`)
}

main().catch(e => { console.error(e); process.exit(1) })
