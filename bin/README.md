# bin/ — 스크립트 가이드

malgnai 웹앱 + 자율 운영 엔진의 로컬(맥미니) 운영 스크립트 모음. 용도별로 4개 그룹.

## 1. 빌드 (vue-zero 스캔)

| 파일 | 역할 | 호출 경로 |
|------|------|-----------|
| [scan.js](scan.js) | `app/pages` `app/components` 스캔 → `pages.json` `components.json`, `server/api` 스캔 → `_registry.js` 생성 | `pnpm run scan`, hook-scan.js |
| [hook-scan.js](hook-scan.js) | PostToolUse 훅. `.vue` 저장 시 `scan.js app`, `server/api/*` 저장 시 `scan.js server` 자동 실행 | `.claude/settings.json` 훅 |
| [hook-stop-mcp-reminder.cjs](hook-stop-mcp-reminder.cjs) | Stop 훅. 세션 종료 시 malgnai-mcp 기록 리마인더 | `.claude/settings.json` 훅 |

## 2. 동기화 (로컬 → 서버 sqlite)

| 파일 | 역할 | 호출 경로 |
|------|------|-----------|
| [sync-projects.js](sync-projects.js) | `~/workspace` 폴더 스캔 → `POST /api/projects/sync` | `pnpm run sync-projects`, sync-all.sh |
| [sync-agents.js](sync-agents.js) | `~/.claude/agents/*.md` 파싱(+스킬 평가) → 서버 동기화 | `pnpm run sync-agents`, sync-all.sh |
| [sync-claude.js](sync-claude.js) | `.claude` 로그/토큰 통계/메모리/세션 동기화 | `pnpm run sync-claude`, sync-all.sh |
| [skill-definitions.js](skill-definitions.js) | 에이전트별 필수 스킬 정의(데이터) — sync-agents.js가 import | (라이브러리) |
| [sync-all.sh](sync-all.sh) | 서버 기동 확인 후 sync-projects → sync-agents → sync-claude 순차 실행, 로그 → `logs/sync-all.log` | `com.malgnai.sync` LaunchAgent (600s) |
| [token-report.js](token-report.js) | 토큰 사용 "도둑 색출" 리포트 (DB만 읽어 0토큰) | `pnpm run token-report` |
| [migrate.js](migrate.js) | 데이터 마이그레이션 명시 트리거(백업+무결성 검증 후 실행) | `pnpm run migrate` |

## 3. 자율 운영 (LaunchAgent 5개, 2026-07-03 단순 코어 전환 P4로 8→5 통합)

| 파일 | 역할 | 호출 경로 |
|------|------|-----------|
| [loop.js](loop.js) | 단순 코어 루프 단일 러너. 매 틱 (1) `lib/spawn-due.js`의 `spawnDueOnce()` → (2) `lib/poll-commands.js`의 `pollOnce()` 순서 실행. 옛 `poll`+`autoloop` 2개 LaunchAgent를 통합 | `com.malgnai.loop` (60s) |
| [poll-commands.js](poll-commands.js) | `lib/poll-commands.js`의 `pollOnce()`를 부르는 얇은 CLI 래퍼 — 큐 다음 1건을 지금 당장 돌려보고 싶을 때 수동 실행용 | 수동 디버깅 (`node bin/poll-commands.js`) |
| [backup-db.sh](backup-db.sh) | sqlite 온라인 백업(VACUUM INTO + 무결성 검증) | `com.malgnai.backup` (6h) |

※ `run-scheduled-jobs.js`(정기업무 스케줄러)·`scheduled-jobs.json`·`retro.sh`/`retro-guard.js`/`retro-prompt.txt`(자동 회고)는 2026-07-03 단순 코어 전환(P4)으로 완전 제거됨 — 단순 코어 5줄 모델과 무관한 부가 기능이었다.

## 4. 라이브러리 / 기타

| 파일 | 역할 |
|------|------|
| [lib/spawn-due.js](lib/spawn-due.js) | `POST /api/lead/spawn-due` 호출 — 프로젝트별 분산 자율 워커 스폰. `spawnDueOnce()`를 export(loop.js가 import). CLI 단독 진입점 없음(60s 안에 어차피 자동 호출됨) |
| [lib/poll-commands.js](lib/poll-commands.js) | 웹→로컬 명령 실행 워커 로직. `/api/commands/claim`으로 1건 claim → 경로 화이트리스트 검증 → `claude -p` 샌드박스 실행 → 결과 PATCH. `pollOnce()`를 export(loop.js와 bin/poll-commands.js CLI 래퍼가 import). 로그 → `logs/poll-commands.log` |
| [lib/load-api-key.js](lib/load-api-key.js) | `.dev.vars`에서 `MALGNAI_API_KEY` 로드 — lib/spawn-due.js·lib/poll-commands.js가 import |
| [sandbox/worker.sb.template](sandbox/worker.sb.template) | lib/poll-commands.js가 `claude -p` 실행 시 사용하는 macOS sandbox-exec 프로필 템플릿 |
