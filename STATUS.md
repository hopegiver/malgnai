# STATUS — malgnai
_최종 갱신: 2026-07-14 — 자율엔진(coo·hourly) 워킹트리 재점검: 신규 미커밋 변경 없음(클린 상태 확인). 지난 사이클 이후 다른 세션이 커밋한 루트 잡동사니 정리(`febb4b2`)·과잉 e2e 테스트 제거(`6a56f3a`)를 STATUS.md에 반영. 문서드리프트 0건(check-docs 전체 일치)·최근 24h 자율사이클 실패 0건 재확인(KPI 양쪽 target 충족).
<!-- malgnai-mcp project_id: b00eaa81-7cea-4e38-b1bc-8cb024974cd9 -->

> **malgnai** = **"AI 자율 프로젝트 운영 플랫폼"** — 직원들이 각자 로그인해 자기 업무 프로젝트를 생성하면 AI가 그 프로젝트를 스스로 진행(기획→설계→개발→검증). ⚠️ **2026-07-02 비전 재정의: "1인 회사 운영 OS" 개념 폐기**(decision `e11f376d`). 자율 LEAD 루프 + 승인함 엔진은 라이브(R1)이며 새 비전의 뼈대로 재활용.
> **새 세션은 이 파일(라이브 상태) + `CLAUDE.md`(구조·규칙)면 오리엔테이션 충분.** 구조 상세는 malgnai-mcp memory `96f4878f`/`get_current_context`, 깊은 문서는 `docs/README.md`. **상황 파악하려고 코드/docs 통독 금지.**
> 이 파일이 malgnai 진행 상태의 **단일 소스**다. 작업 착수 전 읽고, 상태가 바뀌면 끝내기 전 갱신한다.
> **길이 규칙(전역 지침):** 완료 항목은 **1줄 요약(+MCP id)**, 완료 섹션은 **최근 5~7개만** 유지. **헤더 라인은 매번 통째로 교체**(과거 세션 "직전:" 체이닝 절대 금지, 1~2문장·약 150자 이내만 — `lessons/malgnai-status-header-chaining.md`). 상세(검증로그·파일목록·근거)는 STATUS.md에 쓰지 말고 MCP(`decision_add`/`memory_add`/`issue_add`)에 남긴다. 과거 이력은 `get_current_context`/`memory_search`로 조회. **"미커밋/확인대기" 문구는 실제 커밋 여부를 `git log`로 재확인한 뒤에만 남긴다** — 확인 없이 다음 세션으로 그대로 체이닝하지 말 것(이번 정정 사례 참고).

## 🟢 현재 라이브 상태

- **⚠️ 자율엔진↔인터랙티브 세션 git 워킹트리 공유 위험(issue `86fa7c85`) — 07-14 정책으로 절반 해소**: "커밋 전 사람 승인"이 전제였던 우회 문제는 대표 지시("AI 작업은 승인 없이 바로 커밋, push/force만 별개")로 전제 자체가 사라져 해소. 다만 **동일 워킹트리를 여러 프로세스(coo·hourly 사이클 + 인터랙티브 세션)가 동시에 건드리는 문제는 여전**: 지난 세션 dangling commit `3c79d8d` 유실 사고가 있었으나(SIGTERM 수정분), 이번 사이클에선 반대로 다른 세션이 재작성해둔 미커밋 변경을 검증 후 그대로 커밋 완료(위 완료목록 `d6ce9d7`) — 협업이 실제로 작동한 사례. 동시편집 충돌 방지 관점의 격리(worktree 분리 등)는 여전히 검토 대상.
- **malgnai 자율 재가동 중(coo·hourly, project `b00eaa81`, DB 실측 `autonomy_enabled=1` 확인, 07-14 재점검)** — 목표: "지속 자기관찰·개선"(엔진↔웹앱분리는 완결돼 폐기). custom_instruction: 게이트(비용상한/연속실패) 재활성화·엔진 안전판단 변경은 승인함 경유, 사소한 수정만 자동. KPI: 문서드리프트 target 0건, 오류건수 target 0건(측정불가 "완성도" 점수는 폐기). kpi_complete_action=continue라 KPI 달성해도 자동종료 안 됨.
- **유일 실동작 자율 안전게이트 = `risk_approval_threshold`**(기본 high, low/medium만 자동집행 후보) — `server/lib/autonomy.js#riskAllowsAuto()`. 기존 비용상한/연속실패 게이트 3종은 여전히 DEV MODE로 우회 중이며 재활성화는 반복 보류(decision `583239ac`/`83785da8`/`37cb6f3d`) — **먼저 상의 없이 건드리지 말 것**. 안정성 판단은 감이 아니라 `/autonomy`의 실측 실패율(cycles_failed/cycles_total, commit `b075ac1`)로.
- **엔진↔웹앱 분리 Phase 0~3 完(07-12/07-13)** — `com.malgnai.engine`이 유일한 실행경로, 구 HTTP 라우트 3종 물리삭제 완료(commit `9be5b60`). Phase 4(선택·저우선순위: cycle-ingest/autonomy.js를 engine/로 물리이전)만 남음. 실시간모니터 브리징 race 버그는 07-14 수정 完(decision `8cdc959a`).
- **승인함 신뢰성 기반 다짐 완료** — 승인/반려/수정요청 3종 모두 memories(FEEDBACK) 통일기록(commit `cf0ad61`, decision `3e17ff4b`), 자율 워커 proposal 큐잉 시 푸시알림 배선(commit `b083102`), 실시간 실행모니터가 엔진 프로세스 이벤트까지 커버(commit `b9da9cf`). 잔여 한계: cadence-off/비자율 프로젝트는 project_cycle 강제주입 통로 자체가 없어 피드백 미도달(후속 검토 대상).
- **운영:** 로컬 Node(:9000) + Cloudflare Named Tunnel. DB=단일 sqlite `data/malgnai.db`. 에이전트 MCP=저장소 내 `mcp/`(12툴). GitHub 공개 배포 저장소: `github.com/hopegiver/malgnai`(`bin/build-public-dist.sh`로 반영, decision `4c1dab2a`).

## ✅ 최근 완료 (상세=MCP decision id)

- **[07-14] 루트 잡동사니 정리 + 과잉 e2e 테스트 제거** — 다른 세션이 커밋한 정리 작업 확인(구현노트 md·vue-zero.js.bak·스크린샷 PNG·일회성 테스트 스크립트 삭제 `febb4b2`, 프로젝트 생성 왕복 phase-chain e2e 삭제 — 단위테스트로 충분 `6a56f3a`). 워킹트리는 현재 클린.
- **[07-14] 워킹트리 미커밋 변경 검증 후 커밋 — 콘솔 IME Enter 버그 + 프로젝트 소유자 표시 + 검증 스킬** — hourly 점검 중 다른 세션이 만들어둔 미커밋 diff(console.vue, projects.vue, .claude/skills/verify) 발견. 내용 검토 결과: (1) 한글 등 IME 조합 중 Enter로 메시지가 조기 전송되던 버그를 `e.isComposing`/`keyCode 229` 체크로 방지, (2) 프로젝트 카드에 `owner_user_id` 표시(다중 소유권 모델 도입 이후 구분 필요), (3) 웹앱 런타임 검증 레시피 스킬(서버/인증/Playwright/IME 검증법) 신규. 서버 프로세스 단수 확인(동시편집 아님)·owner_user_id 필드 실재 확인(`SELECT *` 포함)·정적서빙 200 확인 후 커밋. commit `ebc5486`.
- **[07-14] 홈 대시보드 사용자 필터 누락 버그 수정** — `commands.inboxSummary()`만 소유권 스코프(projectAccessWhere)가 적용되고 프로젝트 카운트/목록·최근 활동·열린 이슈·프로젝트별 AI 투입 Top은 그대로 시스템 전체가 노출되던 버그. 4개 DAO에 optional user 스코프 추가, 기계 전체 집계(ai_cost·ai_activity)는 super_admin 전용으로 숨김(대표 확인). chhwi(admin) 토큰 실측 검증 完. decision `b2897939`. commit `c5ed199`.
- **[07-14] 명령 재실행 — direct:true 자가승인으로 정정** — 초기엔 "재실행도 승인함 queued 재경유"로 구현했으나(decision `869e528b`) 대표 지시로 뒤집힘: 재실행 버튼을 누른 행위 자체가 승인이므로 §3-1과 동일하게 자가승인('approved')+즉시 클레임/디스패치. `retry_of_id` 컬럼(migrations/015, phase-chain MAX_PHASE_ROUNDS 오염 방지로 parent/root_command_id 미재사용)·session_id 유무 분기(resume 재사용/원본 클론)·§7 active-1 체크는 그대로 유지. curl로 전체 파이프라인 실측 검증. decision `88ea8b75`. commit `93d75d5`+`40c2a14`.
- **[07-14] 프로젝트 상세 "작업 카드 만들기" 승인함 우회(direct:true 자가승인)** — submitTask가 POST /api/commands에 direct:true를 실어 기존 §3-1 자가승인 경로(로컬명령과 동일)를 재사용, status='approved'로 즉시 실행 큐행. 실측 검증(curl+JWT) 完. decision `ea7a0ad1`. commit `fe04850`.
- **[07-14] 콘솔 세션 목록 activeTurnId 미초기화 버그 수정** — selectSession/startNewSession이 activeTurnId(진행중 턴 추적 state)를 리셋 안 해 pending 행을 본 뒤 다른 세션 클릭 시 두 행이 동시에 active + stuck 행 재클릭 무반응. `app/pages/console.vue` 수정. issue `ea23298b` resolved, memory `35a6c608`(교훈). commit `6cf785b`.
- **[07-14] 콘솔 세션 목록 상태필터 완전 제거 + is_synthetic 라우팅 분리** — `findConsoleSessions`가 session_id 미배정 행을 status로 걸러내던 것(stale-reap 실패 턴 누락, issue `f8017ff3` resolved)을 없애 전부 노출, is_pending(표시)과 is_synthetic(라우팅) 역할 분리로 종결된 synthetic 행 클릭 404 방지. commit `f4fdd7c`+`e38309e`. memory `79ba3ba4`(교훈).
- _그 이전(commands/dashboard/lead super_admin 확장, 기능요청 자동심사 파이프라인 `c7239ac` 등)은 `get_current_context`/`memory_search`로 조회._

## 🚧 차단 없는 백로그 (비차단)

- **비전 P1 착수**: 비전 재정의 로드맵 P1~P5 순차 진행(P0 完).
- Jira 파이프라인·Phase 3 LEAD·MCP 가지치기 — 여유 시간에 처리.

## 📌 핵심 메모

- **상태=STATUS.md 한 줄 / 상세=MCP** — 이중기록 아니라 역할 분담. STATUS.md를 다시 통짜로 부풀리지 말 것(decision `c688d96c`). **헤더 라인은 절대 "직전:"으로 체이닝하지 않는다** — 매번 완전 교체(`lessons/malgnai-status-header-chaining.md`).
- **MCP 역할 경계: 기억한다, 실행하지 않는다.** 프로젝트/태스크/에이전트 상태변경(create/update/delete)은 앱 게이트(승인함)의 역할, MCP는 조회+append 기록만.
- **B-5 사업모듈 보류** — 실제 SaaS 고객/매출 데이터 유입 전까지 만들지 않음(유령 메뉴 방지).
- **비파괴 ADD COLUMN 마이그레이션**은 재승인 없이 배포 허용(전후 row count 보존 실증 조건). decision `8c58dece`.
- **상용화 모델 = SaaS 아닌 고가 개별구축**(턴키: 박스/서버+클로드계정+전용 에이전트설계+교육+안전장치). 멀티테넌시 재설계 불요. decision `aa94fc2d`.
