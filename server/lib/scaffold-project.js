// 신규 프로젝트 표준 스캐폴더 — 웹 "새 프로젝트" 생성 시 워크스페이스 폴더를 실제로 만든다.
// ~/.claude/bin/new-project.mjs(CLI 스캐폴더)와 동일한 뼈대(STATUS.md/CLAUDE.md/docs/README.md/
// .claude/doc-drift.json/package.json + git init)를 스탬프한다. 프로젝트명 = 폴더명 규칙(전역 CLAUDE.md)을
// 서버 측에서도 강제하기 위해 로직을 이식했다.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

// 폴더명으로 그대로 쓰일 것이므로 영문 소문자/숫자/하이픈만 허용(kebab-case), 공백 금지.
export const PROJECT_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function validateProjectName(name) {
  if (!name || typeof name !== 'string') return '프로젝트명을 입력하세요'
  if (name.length < 2 || name.length > 50) return '프로젝트명은 2~50자여야 합니다'
  if (!PROJECT_NAME_RE.test(name)) {
    return '프로젝트명은 영문 소문자·숫자·하이픈(-)만 사용할 수 있습니다 (공백 불가, 예: my-project)'
  }
  return null
}

export function scaffoldProject(root, name, description, id, kind) {
  if (existsSync(root)) {
    const err = new Error(`이미 존재하는 폴더입니다: ${root}`)
    err.code = 'PROJECT_DIR_EXISTS'
    throw err
  }
  const desc = description || '<한 줄 설명>'
  const today = new Date().toISOString().slice(0, 10)
  // 웹 생성 경로는 DB row id 를 이미 알고 있으므로(호출측이 미리 발급) 플레이스홀더 없이 바로 채운다.
  // sync-projects.js 가 .claude/project.json 을 id 조회 1순위로 신뢰하므로 이것도 같이 남긴다.
  const idComment = id || '(project_create 후 채우기)'

  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, '.claude'), { recursive: true })

  const files = {
    'STATUS.md': `# STATUS — ${name}
_최종 갱신: ${today} (초기 생성)_
<!-- malgnai-mcp project_id: ${idComment} -->

> **${name}** = ${desc}
> **새 세션은 이 파일(라이브 상태) + \`CLAUDE.md\`(구조·규칙)면 오리엔테이션 충분.** 구조 상세는 malgnai-mcp \`get_current_context\`, 깊은 문서는 \`docs/README.md\`. 상황 파악하려고 코드/docs 통독 금지.
> 이 파일이 진행 상태의 **단일 소스**다. 착수 전 읽고, 상태가 바뀌면 끝내기 전 갱신.

## 🟢 현재 상태
- (프로젝트 시작 — 초기 상태)

## ✅ 최근 완료
- _(없음)_

## 🚧 진행 중 / 다음
- (첫 목표를 여기에)

## ⛔ 막힌 것 / 열린 이슈
- _(없음)_
`,

    'CLAUDE.md': `# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

<!-- 구조 드리프트 대조: .claude/doc-drift.json + \`pnpm run check-docs\`. 전역 SessionStart 훅이 세션 시작 시 자동 경고. -->

## 새 세션 부트스트랩 (읽기 순서 = 토큰 예산)
새 세션은 **자동 주입되는 \`STATUS.md\` + 이 \`CLAUDE.md\` 두 개면 오리엔테이션이 끝난다.** 현 상황 파악하려고 코드/docs를 통독하지 말 것.
- **L0 (자동 주입):** \`STATUS.md\`(라이브 상태) + \`CLAUDE.md\`(안정 구조·규칙). → 시작에 충분.
- **L1 (필요 시 pull):** malgnai-mcp \`get_current_context\` / \`decision_list\` / \`memory_search\`.
- **L2 (깊은 작업만):** \`docs/README.md\` 지도 → 필요한 문서만.

**필수 규율:** ①진행 상태는 \`STATUS.md\` 단일 소스(끝내기 전 갱신). ②주요 결정/이슈/교훈은 malgnai-mcp에 기록. ③구조를 바꾸면 \`.claude/doc-drift.json\`과 아래 서술을 함께 갱신.

## Project Overview
${name} — ${desc}

## Tech Stack
- (채우기)

## Commands
\`\`\`bash
pnpm run check-docs    # 구조 서술 ↔ 코드 실측 드리프트 대조
\`\`\`

## Architecture
- (구조를 여기 서술하고, 검증 가능한 수치는 .claude/doc-drift.json 에 등록)
`,

    'docs/README.md': `# docs/ 문서 지도 (에이전트 진입점)

> 무엇을 어디서 읽을지 여기서 먼저 확인. 현 상태의 정답은 항상 코드 + \`/STATUS.md\`.

## 🧭 먼저 읽을 것
1. \`/STATUS.md\` — 현재 진행 상태(단일 소스)
2. \`/CLAUDE.md\` — 개요·구조·규칙
3. malgnai-mcp \`get_current_context\` — 검색 가능한 결정/이슈/메모리

## 📂 폴더
- \`vision/\` — 아이디어·비전
- \`architecture/\` — 설계·명세
- \`guides/\` — 현행 운영/개발 가이드
- \`history/\` — 회고·리뷰·작업이력

> **정확성 보증:** 새 세션 시작 시 드리프트 가드가 \`.claude/doc-drift.json\`으로 문서↔코드를 대조. 수동 \`pnpm run check-docs\`.
`,

    '.claude/doc-drift.json': JSON.stringify({
      _help: '문서 서술이 코드와 어긋나는지 자동 대조. label/expected 와 측정법(glob|homeGlob|jsonLength|file+regex) 지정. 예시는 malgnai의 .claude/doc-drift.json 참고.',
      checks: [],
    }, null, 2) + '\n',

    'package.json': JSON.stringify({
      name,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: { 'check-docs': 'node "$HOME/.claude/hooks/doc-drift.mjs"' },
    }, null, 2) + '\n',
  }

  if (id) {
    files['.claude/project.json'] = JSON.stringify({ id, description: desc, kind: kind || null }, null, 2) + '\n'
  }

  for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, rel), content)

  try { execSync('git init -q', { cwd: root }) } catch {}
}
