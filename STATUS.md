# STATUS — malgnai-hub
_최종 갱신: 2026-07-27 — WBS(`wbs_items`) v1 반영 확정(3자 토론 후 대표 정정으로 편입, MCP 도구 6→10개, architecture.md §0 결정20)._
<!-- malgnai-mcp project_id: 693caed1-0d3d-4819-b787-75baa829bb80 -->

> **malgnai-hub** = **"맑은소프트 공통 프로젝트 메모리 MCP + 대시보드"** — 프로젝트 운영 이벤트 허브이자 Claude Code 플러그인의 조직 학습 시스템. 회사 전 직원이 공유하는 공통 MCP로 프로젝트별 작업이력·결정·이슈·상태를 Cloudflare D1에 축적하고, 웹 대시보드로 본인 작업이력·토큰/세션 사용량을 조회한다.
> ⚠️ **2026-07-27 전환**: 이 저장소는 예전엔 private malgnai("1인 AI 자율 프로젝트 운영 플랫폼")의 배포판 미러(`bin/build-public-dist.sh` 1방향 덮어쓰기)였으나, 이제 완전히 새 제품 전용이다. 그 스크립트(또는 이를 호출하는 동기화 스크립트)를 이 저장소에 다시는 실행하지 말 것.
> **새 세션은 이 파일 + `CLAUDE.md`면 오리엔테이션 충분.** 깊은 설계 판단은 `docs/architecture.md`(§0 핵심 결정)·`docs/schema.sql`·`docs/mcp-tools.md`·`docs/api.md`가 정본. **상황 파악하려고 코드/docs 통독 금지.**
> 이 파일이 malgnai-hub 진행 상태의 **단일 소스**다. 착수 전 읽고, 상태가 바뀌면 끝내기 전 갱신한다.
> **길이 규칙(전역 지침):** 완료 항목은 **1줄 요약(+MCP id)**, 완료 섹션은 **최근 5~7개만** 유지. **헤더 라인은 매번 통째로 교체**(과거 세션 "직전:" 체이닝 절대 금지). 상세는 STATUS.md에 쓰지 말고 MCP(`decision_add`/`memory_add`/`issue_add`)에 남긴다. 과거 이력은 `get_current_context`/`memory_search`로 조회.

## 🟢 현재 라이브 상태

- **v1 범위 확정(1단계+2단계만)**: idea.md §25 로드맵 중 프로젝트 메모리 MCP(1단계)+세션/토큰 통계(2단계)까지만 v1. MCP 도구는 `get_my_guidance`를 제외한 10개(WBS 4종 포함) 등록 예정. 3단계(직원 가이드)·4단계(조직학습)는 스키마 초안만 문서화하고 실사용 데이터가 쌓인 뒤 재검토(decision `6100c11a`).
- **WBS(`wbs_items`) v1 편입**: "여러 사람이 같이 보는 협업 도구"라는 잘못된 전제로 논쟁이 커졌으나, 대표가 "project_id 종속 개인 작업계획(AI 연속성+진행률 파악용)"이라 정정하면서 접근권한 리스크가 소멸 — decisions/issues/works와 동일 스코핑의 4번째 테이블로 바로 편입(decision `9c9321b6`).
- **아키텍처 확정 완료**: 단일 Cloudflare Worker(MCP+API+Queue Consumer를 라우트로 분리) + `agents` SDK `McpAgent`(Durable Object) + D1. organizations/project_members 테이블 제거, `projects.user_id` 직접소유+`repositories` 신규, `project_events` 통합 이벤트소싱을 폐기하고 `decisions`/`issues`/`works` 3분리 테이블로 확정. 텔레메트리 수집은 이 저장소가 아니라 외부 OTel Collector가 담당(decision `dfb4e7c4`/`28f6b694`/`74e35446`/`f0629f4d`).
- **정본 문서 4종 분리 확정**: `docs/architecture.md`(핵심 결정+설계 근거)/`schema.sql`(D1 정의)/`mcp-tools.md`(MCP 10종 명세)/`api.md`(REST 명세).
- **⚠️ `docs/`가 `.gitignore` 대상**(`.gitignore:20`) — architecture.md 등 정본 문서 전부가 git 추적 밖에 있다. 의도된 것인지 후속 확인 필요.
- **레거시 정리 진행 중, 커밋 대기**: `bin/`·`engine/` 삭제는 스테이징만 됐고 아직 커밋 전(백업 `~/workspace/malgnai-public-legacy-backup-20260727.tar.gz`). `CLAUDE.md` 전면 교체도 워킹트리에 반영됐으나 미커밋. `server/`·`app/`·`mcp/`·`migrations/`·루트 `schema.sql`은 옛 1인용 구현체로 신제품 코드가 아니다 — 조만간 신제품 코드로 전면 교체·제거 예정(CLAUDE.md "레거시 코드 안내" 참고).
- **구현 코드는 아직 착수 전**: 저장소 루트 `wrangler.jsonc`(Worker+D1+DO+Queue 바인딩)만 스캐폴딩됐고, v1 실제 구현 순서(architecture.md §9.3)의 1번(D1 마이그레이션)부터가 다음 단계. `app/`·`server/`·`mcp/`·`migrations/`는 옛 1인용 구현체가 그대로 남아있고, 이 저장소 하나에서 웹(`app/`)·API(`server/`)·MCP(`mcp/`)를 모두 만드는 구조로 실제 구현 착수 시 교체된다(별도 하위 프로젝트 폴더로 감싸지 않음, architecture.md §2.1).

## ✅ 최근 완료 (상세=MCP decision id)

- **[07-27] WBS(`wbs_items`) v1 반영 확정** — 3자 토론(architect/planner/reviewer) 후 대표 정정으로 협업 리스크 전제 소멸, MCP 도구 6→10개 — decision `9c9321b6`.
- **[07-27] 저장소를 신제품 전용으로 전환** — CLAUDE.md 전면 교체, docs/idea.md 정본 채택. decision `fded5b8f`.
- **[07-27] v1 범위(1+2단계) 확정 + MCP 도구 6종 확정**(`get_my_guidance` 미등록) — decision `6100c11a`.
- **[07-27] 아키텍처 확정 — 단일 Worker+McpAgent(DO)+D1 스키마** — decision `dfb4e7c4`.
- **[07-27] organizations/project_members 제거, `projects.user_id` 직접소유+`repositories` 신설** — decision `28f6b694`.
- **[07-27] `project_events` 이벤트소싱 폐기 → decisions/issues/works 3분리 회귀** — decision `74e35446`.
- **[07-27] 텔레메트리 수집을 외부 OTel Collector 담당으로 재설계** — decision `f0629f4d`.
- _그 이전(옛 private malgnai 이력)은 이 저장소 범위 밖 — 필요 시 malgnai(private) 프로젝트 쪽 `get_current_context`/`memory_search`로 조회._

## 🚧 차단 없는 백로그 (비차단)

- v1 구현 착수: D1 마이그레이션(architecture.md §9.3 순서 1) → 웹 로그인 → 디바이스 페어링 → MCP 10종 도구.
- `docs/`가 `.gitignore` 대상인 이유 확인 — 정본 문서가 버전관리 밖에 있는 게 의도된 것인지.
- `bin/`·`engine/` 삭제 + `CLAUDE.md` 교체 커밋(사용자 확인 대기).

## 📌 핵심 메모

- **상태=STATUS.md 한 줄 / 상세=MCP** — 이중기록 아니라 역할 분담. 헤더 라인은 절대 "직전:"으로 체이닝하지 않는다.
- **이 프로젝트의 malgnai-mcp project_id는 `693caed1-0d3d-4819-b787-75baa829bb80`** — 옛 private malgnai project_id(`b00eaa81...`)와 혼동 금지(memory `84a8b4fb`).
- **레거시 코드(`server/`·`app/`·`mcp/`·`migrations/`·루트 `schema.sql`)는 신제품 아키텍처가 아니다** — 참고 자료로만 쓰고, 아키텍처 판단은 반드시 `docs/architecture.md` 등 정본 문서 기준.
- **패키지 매니저는 pnpm만**(전역 규칙, npm/yarn 금지).
