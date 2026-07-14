# STATUS — malgnai
_최종 갱신: 2026-07-14 — 자가평가 KPI로 자율운영이 의도치 않게 꺼졌던 사고(issue `54d2193d`)를 `kpi_complete_action`(기본 continue) 신설로 구조적 해결(decision `bd36cf0d`) 후, 대표 승인(command `c76ae6b2`) 받아 autonomy_enabled=true 재활성화 完 — DB 실측 확인. project-cycle-prompt.js도 "KPI 달성=무조건 종료 선언" 지시를 제거해 워커가 더 이상 project_status=completed를 오발동하지 않도록 정합. 커밋 대기 3건(옵션칩·모니터버그·이번 기능) 누적, 조만간 정리 필요._
<!-- malgnai-mcp project_id: b00eaa81-7cea-4e38-b1bc-8cb024974cd9 -->

> **malgnai** = **"AI 자율 프로젝트 운영 플랫폼"** — 직원들이 각자 로그인해 자기 업무 프로젝트를 생성하면 AI가 그 프로젝트를 스스로 진행(기획→설계→개발→검증). ⚠️ **2026-07-02 비전 재정의: "1인 회사 운영 OS" 개념 폐기**(decision `e11f376d`). 자율 LEAD 루프 + 승인함 엔진은 라이브(R1)이며 새 비전의 뼈대로 재활용.
> **새 세션은 이 파일(라이브 상태) + `CLAUDE.md`(구조·규칙)면 오리엔테이션 충분.** 구조 상세는 malgnai-mcp memory `96f4878f`/`get_current_context`, 깊은 문서는 `docs/README.md`. **상황 파악하려고 코드/docs 통독 금지.**
> 이 파일이 malgnai 진행 상태의 **단일 소스**다. 작업 착수 전 읽고, 상태가 바뀌면 끝내기 전 갱신한다.
> **길이 규칙(전역 지침):** 완료 항목은 **1줄 요약(+MCP id)**, 완료 섹션은 **최근 5~7개만** 유지. **헤더 라인은 매번 통째로 교체**(과거 세션 "직전:" 체이닝 절대 금지, 1~2문장·약 150자 이내만 — `lessons/malgnai-status-header-chaining.md`). 상세(검증로그·파일목록·근거)는 STATUS.md에 쓰지 말고 MCP(`decision_add`/`memory_add`/`issue_add`)에 남긴다. 과거 이력은 `get_current_context`/`memory_search`로 조회. **"미커밋/확인대기" 문구는 실제 커밋 여부를 `git log`로 재확인한 뒤에만 남긴다** — 확인 없이 다음 세션으로 그대로 체이닝하지 말 것(이번 정정 사례 참고).

## 🟢 현재 라이브 상태

- **[07-14] 승인함 구조화 선택지 기능 — 구현/검증 完, 커밋 대기**: `commands.options_json`(migrations/010) + MCP `command_add options` 파라미터 + `/approvals` 옵션 칩 UI. 대표가 "선택형 질문인데 입력창이 없다"고 지적한 갭 해소. decision `70dd5eea`.
- **[07-14] 실행모니터 완료항목 미제거 버그 수정 — 구현/검증 完, 커밋 대기**: `engine/safety-poll.js` postMonitorEvent('end') await 누락(race)이 원인, 최소수정 1파일. decision `8cdc959a`.
- **malgnai 자율 재가동 중(coo·hourly, project `b00eaa81`, DB 실측 `autonomy_enabled=1` 확인, 07-14 재점검)** — 목표: "지속 자기관찰·개선"(엔진↔웹앱분리는 완결돼 폐기). custom_instruction: 게이트(비용상한/연속실패) 재활성화·엔진 안전판단 변경은 승인함 경유, 사소한 수정만 자동. KPI: 문서드리프트 target 0건, 오류건수 target 0건(측정불가 "완성도" 점수는 폐기). kpi_complete_action=continue라 KPI 달성해도 자동종료 안 됨.
- **유일 실동작 자율 안전게이트 = `risk_approval_threshold`**(기본 high, low/medium만 자동집행 후보) — `server/lib/autonomy.js#riskAllowsAuto()`. 기존 비용상한/연속실패 게이트 3종은 여전히 DEV MODE로 우회 중이며 재활성화는 반복 보류(decision `583239ac`/`83785da8`/`37cb6f3d`) — **먼저 상의 없이 건드리지 말 것**. 안정성 판단은 감이 아니라 `/autonomy`의 실측 실패율(cycles_failed/cycles_total, commit `b075ac1`)로.
- **엔진↔웹앱 분리 Phase 0~3 完(07-12/07-13)** — `com.malgnai.engine`이 유일한 실행경로, 구 HTTP 라우트 3종 물리삭제 완료(commit `9be5b60`). Phase 4(선택·저우선순위: cycle-ingest/autonomy.js를 engine/로 물리이전)만 남음. 실시간모니터 브리징 race 버그는 07-14 수정 完(decision `8cdc959a`).
- **승인함 신뢰성 기반 다짐 완료** — 승인/반려/수정요청 3종 모두 memories(FEEDBACK) 통일기록(commit `cf0ad61`, decision `3e17ff4b`), 자율 워커 proposal 큐잉 시 푸시알림 배선(commit `b083102`), 실시간 실행모니터가 엔진 프로세스 이벤트까지 커버(commit `b9da9cf`). 잔여 한계: cadence-off/비자율 프로젝트는 project_cycle 강제주입 통로 자체가 없어 피드백 미도달(후속 검토 대상).
- **운영:** 로컬 Node(:9000) + Cloudflare Named Tunnel. DB=단일 sqlite `data/malgnai.db`. 에이전트 MCP=저장소 내 `mcp/`(12툴). GitHub 공개 배포 저장소: `github.com/hopegiver/malgnai`(`bin/build-public-dist.sh`로 반영, decision `4c1dab2a`).

## ✅ 최근 완료 (상세=MCP decision id)

- **[07-13] PWA 재로그인 불편 해소 — refresh token(30일·회전형) 인증연장, 동시성버그 발견·수정** — commit `dfa17c2`/`9aec31d`. auth 단위30/30.
- **[07-13] 위험도 승인 임계값(`risk_approval_threshold`)+cadence 3/6/12h 추가 — 유일 실동작 안전게이트 신설** — commit `db1a580`/`9aec31d`, decision `4763f164`. 후속 risk_level 판단기준 프롬프트 보강 commit `3ea9c74`.
- **[07-13] 자율실행 웹서버즉시스폰 제거→엔진전용화 + 승인함 3종 memories 통일기록** — commit `cf0ad61`, decision `3e17ff4b`. e2e 검증 중 발견한 project-null 가드 누락 near-miss도 즉시 수정(issue `3a291e8c` resolved, memory `3ce2bc0b`).
- **[07-13] 모바일 하단탭바+승인함 푸시알림 배선+PWA아이콘 캐시버스팅+app_settings 범용CRUD** — commit `b083102`/`da6e121`. 고아 malgnai-lead 문구 정리 commit `460e388`.
- **[07-13] 엔진↔웹앱분리 Phase 3 완결(410 Gone 라우트 물리삭제) + 엔진→서버 실시간모니터 브릿지 복구** — commit `9be5b60`/`ecfbd9a`/`b9da9cf`.
- **[07-13] 자율제어판 관찰 대시보드 확장(비용/실패율/최근결과) + malgnai 자율 재가동** — commit `b075ac1`, decision `779cfe24`.
- **[07-13] 자율설정 확장(custom_instruction+KPI 자동완성) + MCP `project_autonomy_get/update` 신설** — commit `9948c66`.
- _그 이전(07-12 engine설정UI·비용한도버그, 07-11 AI콘솔UX·phase-chain E2E, 07-10 승인함뱃지·로그인버그, 07-08 실행모니터, 07-07 UI/UX재설계 등)은 `get_current_context`/`memory_search`로 조회._

## 🚧 차단 없는 백로그 (비차단)

- **비전 P1 착수**: 비전 재정의 로드맵 P1~P5 순차 진행(P0 完).
- Jira 파이프라인·Phase 3 LEAD·MCP 가지치기 — 여유 시간에 처리.

## 📌 핵심 메모

- **상태=STATUS.md 한 줄 / 상세=MCP** — 이중기록 아니라 역할 분담. STATUS.md를 다시 통짜로 부풀리지 말 것(decision `c688d96c`). **헤더 라인은 절대 "직전:"으로 체이닝하지 않는다** — 매번 완전 교체(`lessons/malgnai-status-header-chaining.md`).
- **MCP 역할 경계: 기억한다, 실행하지 않는다.** 프로젝트/태스크/에이전트 상태변경(create/update/delete)은 앱 게이트(승인함)의 역할, MCP는 조회+append 기록만.
- **B-5 사업모듈 보류** — 실제 SaaS 고객/매출 데이터 유입 전까지 만들지 않음(유령 메뉴 방지).
- **비파괴 ADD COLUMN 마이그레이션**은 재승인 없이 배포 허용(전후 row count 보존 실증 조건). decision `8c58dece`.
- **상용화 모델 = SaaS 아닌 고가 개별구축**(턴키: 박스/서버+클로드계정+전용 에이전트설계+교육+안전장치). 멀티테넌시 재설계 불요. decision `aa94fc2d`.
