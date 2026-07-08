# STATUS — malgnai
_최종 갱신: 2026-07-07 — **UI/UX 재설계 실사용 검증 完**: 웹앱 즉시디스패치 5연속 실패(원인 `257b7602`) 후 세션에서 직접 인수, 전 페이지 스크린샷 검증 + 승인함 마무리(요약바·기본필터·모달화). vitest 127/127._
<!-- malgnai-mcp project_id: b00eaa81-7cea-4e38-b1bc-8cb024974cd9 -->

> **malgnai** = **"AI 자율 프로젝트 운영 플랫폼"** — 직원들이 각자 로그인해 자기 업무 프로젝트를 생성하면 AI가 그 프로젝트를 스스로 진행(기획→설계→개발→검증). ⚠️ **2026-07-02 비전 재정의: "1인 회사 운영 OS" 개념 폐기**(decision `e11f376d`). 자율 LEAD 루프 + 승인함 엔진은 라이브(R1)이며 새 비전의 뼈대로 재활용.
> **새 세션은 이 파일(라이브 상태) + `CLAUDE.md`(구조·규칙)면 오리엔테이션 충분.** 구조 상세는 malgnai-mcp memory `96f4878f`/`get_current_context`, 깊은 문서는 `docs/README.md`. **상황 파악하려고 코드/docs 통독 금지.**
> 이 파일이 malgnai 진행 상태의 **단일 소스**다. 작업 착수 전 읽고, 상태가 바뀌면 끝내기 전 갱신한다.
> **길이 규칙(전역 지침):** 완료 항목은 **1줄 요약(+MCP id)**, 완료 섹션은 **최근 5~7개만** 유지. **헤더 라인은 매번 통째로 교체**(과거 세션 "직전:" 체이닝 절대 금지, 1~2문장·약 150자 이내만 — `lessons/malgnai-status-header-chaining.md`). 상세(검증로그·파일목록·근거)는 STATUS.md에 쓰지 말고 MCP(`decision_add`/`memory_add`/`issue_add`)에 남긴다. 과거 이력은 `get_current_context`/`memory_search`로 조회.

## 🟢 현재 라이브 상태

- **[07-07] 세션 "(제목 없음)" 근본 수정** — headless/resume/IDE세션은 title 추출 불가(242건 중 159건). `ClaudeDao`가 title 없으면 `commands` 테이블(session_id 조인)에서 대체. 159→82건 개선. vitest 127/127.
- **[07-07] UI/UX 개선 3건** — 활동피드 프로젝트명 JOIN, 홈 `activityTitle` 헬퍼, 프로젝트 상세 STATUS 접기/펼치기.
- **[07-07] 자율 라이프사이클 자동전이 + MCP `project_status_set`**(10번째 툴) — 워커 cycle JSON `project_status` 선언 시 자동 DB 전이+감사로그, 워커 MCP 금지 완화(조회 자유+`command_add` 비동기 승인).
- **[07-07] 프로젝트 상태 이원화**(라이프사이클 vs 가동상태) — sync 10분 클로버 버그 차단 + `activity_status` 파생. decision `3a04ef5f`.
- **[07-07] UI/UX 전면 재설계 실사용 검증 完** — 사이드바 5그룹·홈·프로젝트 카드그리드·상세 5탭·자율제어판 프로젝트별 테이블·승인함(요약바·위험도 기본필터=높음·수정요청 모달화) 전부 스크린샷 대조 확인.
- **자율 엔진 ON, 경로=distributed 단일, `com.malgnai.loop` 가동 중.** 자율 프로젝트: `vibecoding`(lead=coo) — 06:54 cadence→`off` 변경 이력 있음, 실가동 여부는 실측 필요(드리프트 이슈 `b8801df3`).
- **운영:** 로컬 Node(:9000) + Cloudflare Named Tunnel. DB=단일 sqlite `data/malgnai.db`. 에이전트 MCP=저장소 내 `mcp/`(10툴).

## ✅ 최근 완료 (상세=MCP decision id)

- **[07-07] 로그인 브루트포스 방어** — username 5회/15분 실패→429 잠금(`server/lib/login-throttle.js`).
- **[07-07] 라이프사이클 수동 전환 배선** — `PUT /api/projects/:id/status` + 상세 헤더 드롭다운. decision `b136c00d`.
- **[07-07] 웹앱 직접명령 벽시계 타임아웃 수정** — 사람 명령 무제한, 자율 project_cycle만 10분 유지.
- **[07-06] 통합 실행모델 §8/§9/§11/§12 完** — MCP `command_add`·resume 재개·claim 승인게이트·active-1 불변식. decision `4728e959`.
- **[07-06] UI/UX 비주얼 리프레시 完** — 쿨톤 토큰·KPI 타일 통일·로그인 리디자인.
- **[07-06] 스키마 정본 `schema.sql` 일원화** — 좀비 MCP DDL이 삭제 테이블 부활시키던 근본원인 차단.
- _그 이전 이력(비전 재정의 `e11f376d`·자율 아키텍처 확정 `17453720`·단순코어전환 `f467eb52` 등)은 `get_current_context`/`memory_search`로 조회._

## 🚧 진행 중 / 다음

- **🔵 비전 재정의 로드맵**(P0~P5, decision `e11f376d`/`17453720`/`bf673158`) — P0(소유권토대) 完. 블로커: B1 ID계약불일치(issue `0e75aa6a`)·B2 승인함 오너스코핑(issue `9fc5dce0`)·B3 next_run_at 원자갱신(issue `560ebcf8`) 미해결, P1부터 순서 대기.
- resume 다세션 왕복 실e2e 미검증(단위·격리 검증까지만 완료).
- Jira 파이프라인 편입(설계완료·구현대기, `6ad32919`) / Phase 3 LEAD 사이클 뷰(`b0e1b813`) / MCP 가지치기(2026-07 중순 재검토, `892cc119`) — 전부 비차단 대기.

## ⛔ 막힌 것 / 열린 이슈 (전체=MCP `get_current_context`)

- 열린 이슈 다수(15건) — 전체 목록은 MCP `get_current_context`. 주요 high만: node `--watch` 동시편집이 실행중 워커 죽임(`257b7602`), FK CASCADE 미강제(`884f02bf`), `claim()` review_status 미확인(`412d2305`), 무인루프 MCP 미연결(`367241e1`), 학습피드백축 미연결(`2b075223`).
- `dd8b02fc`(medium) COO 위임 게이트 한계 — 비가역 운영작업 위임 불가(구조적, 회피=대표 직접) / `b19875df`(low) 원격 D1 — 폐기로 사실상 무의미(정리 대상).

## 📌 핵심 메모

- **상태=STATUS.md 한 줄 / 상세=MCP** — 이중기록 아니라 역할 분담. STATUS.md를 다시 통짜로 부풀리지 말 것(decision `c688d96c`). **헤더 라인은 절대 "직전:"으로 체이닝하지 않는다** — 매번 완전 교체(`lessons/malgnai-status-header-chaining.md`).
- **MCP 역할 경계: 기억한다, 실행하지 않는다.** 프로젝트/태스크/에이전트 상태변경(create/update/delete)은 앱 게이트(승인함)의 역할, MCP는 조회+append 기록만.
- **B-5 사업모듈 보류** — 실제 SaaS 고객/매출 데이터 유입 전까지 만들지 않음(유령 메뉴 방지).
- **비파괴 ADD COLUMN 마이그레이션**은 재승인 없이 배포 허용(전후 row count 보존 실증 조건). decision `8c58dece`.
- **상용화 모델 = SaaS 아닌 고가 개별구축**(턴키: 박스/서버+클로드계정+전용 에이전트설계+교육+안전장치). 멀티테넌시 재설계 불요. decision `aa94fc2d`.
