# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- 구조 드리프트 대조: 기대값은 `.claude/doc-drift.json` 매니페스트에. `pnpm run check-docs`(전역 훅이 세션시작 시 자동). 구조 변경 시 매니페스트 expected + 아래 구조 서술을 함께 갱신. -->

## 새 세션 부트스트랩 (읽기 순서 = 토큰 예산)

새 세션은 **자동 주입되는 `STATUS.md` + 이 `CLAUDE.md` 두 개면 오리엔테이션이 끝난다.** 현 상황을 파악하겠다고 코드나 docs/를 통독하지 말 것 — 토큰 낭비이자 옛 정보 오독의 원인이다.

- **L0 (자동 주입, 항상 지불):** `STATUS.md`(라이브 상태 — 지금 돌아가는 것·다음·열린 이슈) + `CLAUDE.md`(안정 구조·규칙, 이 파일). → **시작에 충분.**
- **L1 (필요 시 pull):** malgnai-mcp `get_current_context` → 검색 가능한 결정/이슈/메모리. 구조 상세 한 방은 memory `96f4878f`(현행 구조 스냅샷), 과거 맥락은 `decision_list`/`memory_search`. **큰 문서 통독 대신 이걸로.**
- **L2 (깊은 작업일 때만):** `docs/README.md`(문서 지도) → 필요한 설계/이력 문서만 집어 읽기. 무엇이 현행/드리프트/이력인지 지도에 표기됨.

**필수 규율 (비협상):**
1. **진행 상태 = `STATUS.md` 단일 소스.** 착수 전 읽고, 상태가 바뀌면 끝내기 전 갱신한다. 메모리·다른 문서로 상태를 단정하지 않는다. 위임받은 서브에이전트(COO 포함)도 동일 — 사이클 종료 시 STATUS.md 갱신은 COO 책임.
2. **맥락 기록 = malgnai-mcp.** 주요 결정→`decision_add`, 막힌 것→`issue_add`(해결 시 `issue_resolve`), 재사용 교훈·요약→`memory_add`, 의미 있는 활동→`activity_log`. STATUS=상태 한 줄(정답), MCP=검색 가능한 상세(역할 분담, 이중기록 금지). 사소한 단계는 생략, "다음에 또 찾을 것"만 기록.

## Project Overview

**malgnai** — **"AI 자율 프로젝트 운영 플랫폼"**. 직원들이 각자 로그인해 자기 업무 프로젝트를 생성하면, 전역/프로젝트별 에이전트를 활용·학습시켜 AI가 그 프로젝트를 스스로 진행(기획→설계→개발→검증)해 원하는 결과물을 만든다. ⚠️ **2026-07-02 비전 재정의**: 이전 "1인 회사 운영 OS" 개념은 **폐기**(STATUS.md, decision `e11f376d`). 기존에 구축된 자율 LEAD 루프 + 규칙엔진 + 예산게이트 + 승인함(commands 큐)은 **새 비전의 실행 뼈대로 재활용**한다. 모든 데이터는 로컬 sqlite, 터널로 외부(모바일) 접근. 정본 비전: `docs/vision/malgnai-vision.md`, 단순화 정본(현행 방향): `docs/design/simple-core.md`. ※07-02 재설계 상세(`autonomous-platform-redesign.md` 등)와 옛 "1인 SaaS 회사" 문서는 `docs/_archive/`로 강등됨(참고용).

## Tech Stack

- **Frontend**: vue-zero (Vue 3 Options API, 제로빌드), Bootstrap 5, Bootstrap Icons
- **Backend**: Hono on **Node** (`@hono/node-server`) + **better-sqlite3** (로컬 SQLite 파일)
- **인증**: 멀티유저(users 테이블, role=admin/user) + JWT(4h) + 선택적 TOTP 2FA(otplib). 단일 admin 아님.
- **운영**: 맥미니 로컬 Node 서버 상시 기동(:9000) + **Cloudflare Named Tunnel**(`malgnai.apiserver.kr`)로 외부 노출. **Cloudflare Workers/D1/wrangler 는 폐기됨**(2026-06-24 전환).

> 에이전트용 MCP는 **이 저장소 내부** `mcp/`(stdio, JS 소스, 엔트리 `mcp/index.js`, 10 툴 — 이력 기록 5종(`activity_log`·`decision_add`·`issue_add`·`issue_resolve`·`memory_add`)+학습 이력 1종(`agent_learning_log_add`)+**승인 필요 건 등록 1종(`command_add`, 2026-07-06 §8/§9 신설 — 승인함에 queued 등록, session_id 주면 §9 claude --resume 재개)**+**라이프사이클 선언 1종(`project_status_set`, 2026-07-07 신설 — 프로젝트 status 대기/진행/완료/보류 전이. 웹 `PUT /:id/status`와 `server/lib/project-status.js` 계약 공유, 저위험·가역이라 승인함 우회 직접 전이+감사로그. 자율 워커는 대신 cycle JSON `project_status` 필드로도 선언 가능)**+조회 2종(`get_current_context`·`memory_search`), 2026-07-03 실사용 기준 20→8 정리 후 command_add·project_status_set 추가로 10, `coo.md`/`trainer.md` 실제 호출 지침과 대응)로 통합됨(옛 별도 `~/workspace/malgnai-mcp` TS 프로젝트를 흡수). `agent_learning_log_add`·`command_add`·`project_status_set`는 예외적으로 쓰기 허용 — 나머지 조회 툴은 read-only 원칙 유지. 웹앱과 **동일 sqlite 정본**을 공유하며(웹은 `/api/*`, 에이전트는 stdio MCP) DB 경로는 `MALGNAI_DB_PATH`/`DB_PATH`로 지정. 실행 등록: 전역 `~/.claude.json`(user-scope)이 `node mcp/index.js` 를 가리킨다. 1인·단일머신 사용이라 프로젝트 `.mcp.json`은 중복이라 2026-07-08 제거.
> 서버 진입점은 `server/node.js`(유일). 앱 구성은 `server/index.js`의 `createApp(env)` 팩토리. DB 는 D1 호환 어댑터(`server/db/sqlite-adapter.js`)로 better-sqlite3 를 감싸 DAO 무수정. DB 경로는 `DB_PATH`(기본 `data/malgnai.db`) — **정본 sqlite는 `data/malgnai.db`(malgnai 내부)**. **스키마 정본 = 루트 `schema.sql`(단일 소스, 2026-07-06 일원화).** 테이블/인덱스는 여기 하나로 선언하고, 기존 테이블 변경분은 `migrations/NNN-*.sql`에 적는다. 라이브 반영은 **`pnpm run db:migrate`(`bin/db-migrate.js`) 한 경로뿐** — 자동 pre-migrate 백업 후 schema.sql 적용→migrations 순차→`_schema_meta.version`(schema+migrations 지문) 스탬프. **웹서버 부팅과 MCP 는 스키마를 만들지 않는다**: 부팅은 `server/dao/init.js`의 `verifySchema`(읽기전용)로 버전만 대조하고 미초기화/드리프트면 부팅 중단(안내). `mcp/db/schema.js`는 PRAGMA만(테이블 생성 제거). 데이터 백필(1회성)은 별도 `pnpm run migrate`(`bin/migrate.js`). ※이 일원화로 옛 좀비 MCP가 `CREATE IF NOT EXISTS`로 삭제 테이블을 부활시키던 사고(issue `43110872`)를 근본 차단.

## Commands (pnpm 사용 — 전역 규칙)

```bash
pnpm start             # 로컬 서버 기동 (node server/node.js, http://localhost:9000)
pnpm run scan          # pages.json, components.json, _registry.js 갱신
pnpm run sync-agents   # ~/.claude/agents/*.md → 서버 DB 동기화
pnpm run sync-projects # ~/workspace 프로젝트 → 서버 DB 동기화
pnpm run sync-claude   # Claude 세션/토큰/메모리 통계 동기화 (세션·에이전트별 토큰/비용 적재 포함)
pnpm run token-report  # 토큰 "도둑 색출" 리포트 (DB만 읽어 0토큰; --since today|week, --limit N)
pnpm run check-docs    # CLAUDE.md 구조 서술 ↔ 코드 실측 드리프트 대조
pnpm test              # Playwright E2E
```

> **정확성 보증(드리프트 가드):** 전역 SessionStart 훅(`~/.claude/hooks/session-context.mjs`)이 세션 시작 시 STATUS.md 주입과 함께 `.claude/doc-drift.json` 매니페스트로 구조 서술(api/tables/pages/runners/agents)을 코드와 대조한다. **일치하면 아무것도 안 붙이고(0토큰), 어긋나면 경고만 주입**한다. 구조를 바꿨으면 매니페스트 expected + 서술을 갱신하고 `pnpm run check-docs`로 확인. (이 표준은 전 프로젝트 공통 — 전역 `~/.claude/CLAUDE.md` 참조.)

비밀번호/시크릿은 `.dev.vars`(KEY=value)에서 `server/node.js`가 자동 로드. `ADMIN_PASSWORD`=최초 admin 시드 비번(users 비었을 때만), `JWT_SECRET`, `MALGNAI_API_KEY`. 환경변수(`PORT`, `DB_PATH`, `APP_DIR`, `ENVIRONMENT`)로 덮어쓰기 가능.

## vue-zero Rules

- Options API만 사용 (setup/Composition API 금지)
- `<style scoped>` 금지
- 유틸 함수는 `app/assets/js/utils.js`에 추가 (import 불가)
- 파일 추가/삭제 시 `pnpm run scan` (PostToolUse hook이 자동 실행)
- composables/ 사용 금지

## Architecture

- **Layout**: 왼쪽 사이드바 (admin 스타일) — `app/layouts/default.vue`. 컴포넌트는 페이지 내 인라인(app/components 비어있음).
- **Pages (14 + 404 폴백)** (`app/pages/pages.json`): 대시보드(/), 로그인, **승인함(/approvals)**, **자율제어판(/autonomy)**, 사용자관리(/users), 개인설정(/settings), 에이전트(/agents, /agents/:name), 프로젝트(/projects, /projects/:id), 워크스페이스(/workspaces), 활동(/activities), 인사이트(/insights), Claude 모니터(/claude).
- **Server**: Hono API (`server/api/`) + 정적 서빙 + better-sqlite3(D1 호환 어댑터 경유).
- **DAO** (`server/dao/`): activities, agents, claude, commands, context, projects, users, init(스키마).
- **DB Tables (20)** (정본 `schema.sql`, 변경분 `migrations/`): users, projects, **project_collaborators**(프로젝트 소유·협업자 공유), activity_logs, agents, agent_learning_logs, claude_history, claude_stats, claude_memories, claude_sessions, claude_token_stats, claude_model_usage, claude_project_sessions, **claude_session_usage**(세션별 토큰·비용, main/sub 분리·캐시1h·5m), **claude_agent_usage**(서브에이전트 type별 턴/토큰/비용), **commands**(웹→로컬 실행 큐), decisions, issues, memories(Context Router), **app_settings**(전역 K-V, 마스터 킬스위치 등). ※projects/agents/commands 등은 base 스키마 이후 ALTER 마이그레이션으로 컬럼 확장(kind·lead_agent_name·autonomy_*·risk_level 등). **activity_logs**도 재설계로 구조화 컬럼 7 확장(level=work/telemetry/audit·category·title·target_ref·result·links_json·correlation_id). 모든 쓰기는 단일 관문 `server/lib/activity-log.js`(정규화 `activity-normalize.js` 통과) 경유 — 엔진 직접 INSERT 금지. ⚠️ **2026-07-03 단순 코어 전환(P3)**: 실행 규칙 엔진(`execution_rules`)은 최소안전 3종으로 흡수되어 테이블·시드까지 완전 제거됨(`docs/design/simple-core.md`). ⚠️ **2026-07-03 미사용 테이블 정리**: `feedbacks`(완전 배선됐으나 0건 미사용 기능)·`file_summaries`(고아, 참조 無)·`sync_outbox`(폐기된 Cloudflare Workers 원격 아웃박스, 전건 실패 누적 중) 코드+테이블 완전 제거. ⚠️ **2026-07-03 tasks/commands 완전 통합 Phase B**: `tasks` 테이블(및 `decisions`/`issues`/`commands`의 잔존 `task_id` 컬럼) 완전 제거 — tasks→commands 이관은 이미 완료돼 있었고(Phase A), 남은 원본 테이블·죽은 컬럼만 정리(`pnpm run migrate`로 라이브 적용, 사전 백업 확인).

## API (`server/api/`, 11개)

activities, agents, auth(로그인·TOTP·비번), claude(세션/통계 기록), commands(명령 큐·claim·승인카드), context(decisions/issues/memories 읽기), dashboard(집계), **lead**(분산 자율 루프: spawn-due·cycle-result·worker-result + 마스터 자율 킬스위치), **monitor**(실시간 실행 모니터 SSE — `/monitor/stream`으로 exec-monitor.js 이벤트 팬아웃, DB 저장 無·서버 재시작 시 초기화), projects(CRUD·파일탐색·**`/:id/timeline` 3원천 통합 타임라인**), users(관리자 전용 CRUD). activities는 GET level/category 필터·POST 정규화 확장. ※`rules`(실행규칙 CRUD)·`/api/commands/scheduled`(정기업무)는 2026-07-03 단순 코어 전환(P3/P4)으로, `feedbacks`는 2026-07-03 미사용 테이블 정리로, `tasks`(`/api/tasks` 호환 shim)는 2026-07-03 tasks/commands 완전 통합 Phase B 마무리로 제거됨(프로젝트 상세 "작업 카드 만들기"는 `/api/commands` 직접 호출로 전환).

## 자율 운영 엔진 (핵심 — 단순 코어, `docs/design/simple-core.md` 정본)

- **본질 5줄**: 루프가 깨어난다 → 지금 돌 차례인 프로젝트를 고른다(cadence) → 그 프로젝트의 지정 에이전트를 호출한다 → 결과 저장 → 다음 주기 예약.
- **분산(distributed) 단일 경로** — 프로젝트별 지정 에이전트(`projects.lead_agent_name`)가 자기 STATUS.md/goal 을 읽고 스스로 판단한다. central(malgnai-lead 중앙 오케스트레이터) 경로는 2026-07-02 완전 제거됨(decision `f467eb52`).
- **스폰→실행→적재**: `com.malgnai.loop`(60s, `bin/loop.js`)가 매 틱 (1) `POST /api/lead/spawn-due` 호출 — 서버가 due 판정·락·비용게이트·`next_run_at` 갱신·`project_cycle` command INSERT 를 **단일 tx** 로 원자 처리(TOCTOU/이중스폰 차단, 프로젝트당 상시 lead task 1개 재사용) → (2) 명령 큐 1건 claim해 `claude -p` 로 워커 실행 → 결과는 `POST /api/lead/cycle-result`(`server/lib/cycle-ingest.js`, summary→memories + proposal→승인함 command).
- **집행 트랜잭션**: `server/lib/cycle-ingest.js` 가 워커 제안(proposal)마다 **최소안전 3종 게이트 + 워커 `next` 신호**로 status 를 정한다. ⚠️ **2026-07-06 통합 실행모델(`docs/plan/vscode-web-unified-execution.md` §5)**: proposal = "다음 실행단위"이고, `next='auto'`(가역·저위험)이면서 게이트를 통과하면 `approved`(+`reviewed_by='system-autonomy'`)로 **자동 발행**돼 다음 phase 가 이어진다. `next='ask'`(배포·비가역)·필드누락·게이트실패는 모두 `queued`(승인함). 이로써 지금껏 계산만 되던 `canAutoDispatch` 가 실제로 status 를 결정한다(구 "proposal 은 무조건 queued 강제"는 §5 로 폐기).
- **최소안전 3종** (`server/lib/autonomy.js`, 2026-07-03 P3 단순화 — 규칙엔진·다층 예산게이트 제거 후 이것만 남음): ① 마스터 킬스위치 `app_settings.autonomy_enabled`='1' · ② 프로젝트별 `projects.autonomy_enabled`='1' + `cadence`!='off' + `lead_agent_name` 존재 · ③ 일일 비용 상한(`DEFAULT_BUDGET.daily_cost_limit_usd`, 기본 $100) — 초과 시 auto→approve 강등. 셋 다 통과해야 auto. **주의: 설계문서의 `autonomy_level L0~L5`는 미구현.**
- **승인/실행 규율 (2026-07-06 통합 실행모델, `docs/plan/vscode-web-unified-execution.md`)**: **status 자체가 유일한 판별자**(별도 held 플래그 없음). `queued`=held(승인/게이트 대기)의 유일 의미 — poll `claim()`은 **`approved`만** 집는다(§3-3, `queued` 무시로 승인함 우회 봉쇄). 정기 사이클은 `claimed`로 태어나 claim 대상이 아니다. **프로젝트당 active(claimed/running) 최대 1개** 불변식(§7)을 claim·즉시디스패치·spawn-due 3곳이 지켜 phase 가 자연히 순차가 된다. 웹 "로컬 직접 명령"은 `POST /api/commands {direct:true}`로 자가승인(`approved`)돼 승인함을 건너뛴다(§3-1). 수정요청은 원본을 `rejected`+`review_status='changes_requested'`로 마감하고 note 를 `memories(FEEDBACK)`에 적재 → 다음 사이클 워커가 반영(§6, 좀비·재실행 0).
- **승인함**: `/approvals` — 위험·비가역 작업은 commands 로 쌓여 대표 승인/반려/수정요청 대기.
- **실시간 실행 모니터** (`server/lib/exec-monitor.js`): 인메모리 EventEmitter 싱글턴. `dispatch-worker.js`가 실행 시작·완료·stderr 청크를 emit → SSE(`/api/monitor/stream`)로 팬아웃 → `/claude` "실행 모니터" 탭에서 실시간 조회. DB 저장 없음, 서버 재시작 시 초기화. 2026-07-08 신설.
- **직접 명령 단계 이어달리기** (`server/lib/phase-chain.js`): 워커 응답에 `NEXT_PHASE: <다음 지시>` 신호가 있으면 파싱해 다음 단계 command를 **자가승인(approved) + 즉시클레임**으로 생성. §7 active-1 불변식 준수, `MAX_PHASE_ROUNDS=20` 상한. `dispatch-worker.js`(워커 완료 후 체인 판단)·`commands.js PATCH /:id`(수동 완료 시 체인 판단) 양쪽 배선. 2026-07-08 신설(e2e 왕복은 단위 검증까지, 실다세션 미검증).

## 운영 자동화 (맥미니 LaunchAgent 5개)

`~/Library/LaunchAgents/com.malgnai.*.plist`. 로그: `logs/`. 2026-07-03 P4 통합(8→5): `poll`+`autoloop`을 `loop` 1개로 합치고, `scheduler`는 완전 제거. **`retro`(자동 회고)는 P4 때 scheduler와 함께 실수로 같이 삭제됐다가 같은 날 복원** — 단 별도 LaunchAgent를 새로 만들지 않고 `sync`(10분 틱) 끝에 백그라운드 호출로 편승(`bin/retro.sh`), 실제 발동은 `retro-guard.js`의 `RETRO_MIN_INTERVAL_MS`(기본 60분) 게이트로 제한. decision `4cd0383c`.
- `server` — 웹서버(:9000), RunAtLoad+KeepAlive
- `loop`(60s) — `bin/loop.js`: 단순 코어 루프 단일 러너. 매 틱 (1) `bin/lib/spawn-due.js`의 `spawnDueOnce()`(due 스폰) → (2) `bin/lib/poll-commands.js`의 `pollOnce()`(큐 1건 claim→`claude -p`→결과 보고)를 순서대로 실행. 핵심 로직은 `bin/lib/`에 있고, `bin/poll-commands.js`만 수동 디버깅용 얇은 CLI 래퍼로 남는다(spawn-due는 60s 내 자동 호출이라 CLI 래퍼 없음).
- `sync`(600s) — `bin/sync-all.sh`: 프로젝트/에이전트/Claude 세션 동기화 + **자동 회고**(`bin/retro.sh` 백그라운드 호출, guard 통과 시에만 실제 발동)
- `backup`(6h) — `bin/backup-db.sh`: sqlite 온라인 백업(VACUUM INTO + 무결성 검증)
- `cloudflared` — Named Tunnel 유지

## Agent Skill System

- `bin/skill-definitions.js` — 에이전트 역할별 필수 스킬 정의 (팀 분류: 리더십·기획·디자인·개발·품질·커뮤니케이션 등)
- `bin/sync-agents.js` — 전역 `~/.claude/agents/*.md`(19개)를 파싱하여 서버 DB에 동기화 (스킬 수준 1~5 자동 추정)
- **학습 실행**: `trainer` 에이전트가 스킬 진단 → knowledge 자료 수집/생성 → 에이전트 MD 보강

## Knowledge Base

- 위치: `~/.claude/knowledge/` (맥미니) — 에이전트별 역할 지식 중앙 저장소
- `lessons/` : 프로젝트 회고 교훈 축적 (COO/무인 회고가 기록)
- 학습 루프: 작업 전 lessons 확인 → 수행 → 완료 → 회고 → knowledge 업데이트

## Related Projects

- **mcp** (`mcp/`, 이 저장소 내부): 로컬 MCP 서버 (stdio, JS, 에이전트가 직접 사용). 옛 별도 프로젝트 `malgnai-mcp`를 2026-07-03 흡수 통합. `workspace_scan` 도구로 로컬 폴더 스캔. (아카이브: `~/workspace/malgnai-mcp.archived-20260703`)
- **Global agents** (`~/.claude/agents/`): 19개 전문가 에이전트 MD 파일(+ malgnai-lead).
