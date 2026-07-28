# STATUS — malgnai-hub
_최종 갱신: 2026-07-28 — bootstrap_project가 CLAUDE.md/docs/README.md/폴더 스캐폴드까지 반환하도록 확장 배포, https://malgnai-hub.malgnsoft.workers.dev 실배포 유지 중._
<!-- malgnai-mcp project_id: 693caed1-0d3d-4819-b787-75baa829bb80 -->

> **malgnai-hub** = **"맑은소프트 공통 프로젝트 메모리 MCP + 대시보드"** — 프로젝트 운영 이벤트 허브이자 Claude Code 플러그인의 조직 학습 시스템. 회사 전 직원이 공유하는 공통 MCP로 프로젝트별 작업이력·결정·이슈·상태를 Cloudflare D1에 축적하고, 웹 대시보드로 본인 작업이력·토큰/세션 사용량을 조회한다.
> **새 세션은 이 파일 + `CLAUDE.md`면 오리엔테이션 충분.** 깊은 설계 판단은 `docs/architecture.md`(§0 핵심 결정)·`docs/schema.sql`·`docs/mcp-tools.md`·`docs/api.md`가 정본. **상황 파악하려고 코드/docs 통독 금지.**
> 이 파일이 malgnai-hub 진행 상태의 **단일 소스**다. 착수 전 읽고, 상태가 바뀌면 끝내기 전 갱신한다.
> **길이 규칙(전역 지침):** 완료 항목은 **1줄 요약(+MCP id)**, 완료 섹션은 **최근 5~7개만** 유지. **헤더 라인은 매번 통째로 교체**(과거 세션 "직전:" 체이닝 절대 금지). 상세는 STATUS.md에 쓰지 말고 MCP(`decision_add`/`memory_add`/`issue_add`)에 남긴다. 과거 이력은 `get_current_context`/`memory_search`로 조회.

## 🟢 현재 라이브 상태

- **v1 실배포 완료**: `https://malgnai-hub.malgnsoft.workers.dev` (Cloudflare Worker 단일, D1 `malgnai-hub` database_id `03e447c3-7080-47ca-8b1e-876bba84e3ab`). `app/`은 별도 Pages 대신 Worker 정적 자산(assets) 바인딩으로 같은 URL에서 서빙(`/api/*`·`/mcp*`만 `run_worker_first`로 Worker 강제 라우팅) — architecture.md §1/§9.2의 Pages 분리안에서 벗어난 결정(decision `7165ccd5`).
- **구현 범위**: architecture.md §9.3 순서 1~5 전부 + sessions/usage_daily 스키마(POST /api/sessions·사용량 화면 실구현은 미착수, 2단계 후반부 백로그). JWT(4h)+refresh(30일 회전형, 재사용 grace window 10초) 로그인, 디바이스 페어링, MCP 10개 도구(mcp/agent.js, McpAgent/DO), REST 읽기 API(projects/decisions/issues/works/wbs), app/ 웹 화면(로그인/대시보드/프로젝트상세/페어링승인/사용량) — 전부 배포된 URL에서 스모크 테스트 통과(로그인→REST, 디바이스페어링→MCP tools/list→record_work 쓰기→REST 재조회→디바이스 폐기 즉시 차단).
- **administrator 계정 시드 완료**: `dev@malgnsoft.com` / role=administrator. 임시 비밀번호는 대표에게 이 세션 대화로 별도 전달(STATUS.md/git에는 없음) — 최초 로그인 후 비밀번호 변경 API가 아직 없으니(REST 읽기 API만 v1 범위) 3단계 이전에라도 추가 필요.
- **사내 private malgnai 프로젝트를 검증된 참고자료로 활용**: DAO 레이어가 D1 호환 어댑터 패턴으로 이미 짜여 있어 대조가 쉬웠고, 대조 중 실사용 버그 2건 발견·수정(vue-zero.js JWT base64url 디코딩 버그, refresh token 재사용 grace window 누락) — decision `330e54a2`, issue `92dc5d43`(해결)/`18a07e45`(해결).
- **v1 범위 확정 그대로 유지**: idea.md §25 로드맵 중 1단계+2단계까지만. MCP 도구는 `get_my_guidance` 제외 10개(WBS 4종 포함). 3단계(직원 가이드)·4단계(조직학습)는 스키마 초안만 문서화, 실사용 데이터 쌓인 뒤 재검토(decision `6100c11a`).
- **⚠️ `docs/`가 `.gitignore` 대상**(`.gitignore:20`, 의도된 설계 — "문서 창고, git 추적 제외" 주석 확인됨) — architecture.md 등 정본 문서는 로컬에만 있고 원격 저장소엔 없다. 새 환경(다른 macOS 사용자·CI)에서 이어받으려면 이 로컬 디스크의 docs/를 별도로 전달해야 한다.

## ✅ 최근 완료 (상세=MCP decision id)

- **[07-28] `bootstrap_project` 출력 확장** — claudeMarkdown(MCP 사용규칙+STATUS.md 작성규칙 내장)/docsReadmeMarkdown/scaffoldFolders(고정 `["docs","src","output"]`) 추가. 실제 파일쓰기는 여전히 플러그인(보류) 몫 — commit `4a35923`, decision `e901d168`.
- **[07-27] MCP 11번째 도구 `bootstrap_project` 추가** — repositories/projects get-or-create(멱등) + 서버가 조립하는 STATUS.md(YAML frontmatter `malgnai_hub:` 블록, 사내 malgnai-mcp 관례와 이름·형식 분리). 플러그인 연동은 범위 밖(보류) — commit `6675537`, decision `ee32e109`.
- **[07-27] 계정관리 라운드 배포** — 프로필/비밀번호변경/관리자 사용자관리(GET·POST·PATCH /api/admin/users, 마지막관리자 보호)/인증키(디바이스) 관리+.mcp.json 복사·다운로드. 실 URL 스모크 테스트 통과, commit `9870af9`. MCP 인증 OAuth 도입은 이번엔 보류 — decision `bfc11390`.
- **[07-27] v1 실배포 + 스모크 테스트 통과** — 위 "현재 라이브 상태" 참고. 전체 WBS는 `wbs_list`로 조회.
- **[07-27] 사내 malgnai 소스 대조로 실사용 버그 2건 발견·수정** — decision `330e54a2`.
- **[07-27] app/를 Worker assets 바인딩으로 단일 배포 결정** — decision `7165ccd5`.
- **[07-27] WBS(`wbs_items`) v1 반영 확정** — MCP 도구 6→10개(→11개, 위 참고) — decision `9c9321b6`.
- _그 이전(아키텍처 확정 등 옛 이력)은 `decision_list`/`memory_search`로 조회._

## 🚧 차단 없는 백로그 (비차단)

- 2단계 후반부: `POST /api/sessions`(OTel Collector 연동) + 사용량 웹 화면 실데이터 연결(화면 뼈대는 이미 있음, mock 없이 빈 상태만 확인됨).
- `docs/`가 git 추적 밖이라 원격에는 정본 문서가 없음 — 다른 머신에서 이어받을 계획이 있으면 docs/ 전달 방법을 정해야 함.
- Claude Code 플러그인(회사 공통 배포용) 자체는 이 저장소 범위 밖 — 지금은 `/keys` 화면에서 수동 발급한 `.mcp.json`을 직접 붙여넣는 방식으로만 MCP 연결 가능.
- MCP 인증 OAuth 병행 도입은 claude.ai 원격 연동 요구가 실제로 생기면 재검토(decision `bfc11390`).

## 📌 핵심 메모

- **상태=STATUS.md 한 줄 / 상세=MCP** — 이중기록 아니라 역할 분담. 헤더 라인은 절대 "직전:"으로 체이닝하지 않는다.
- **이 프로젝트의 malgnai-mcp project_id는 `693caed1-0d3d-4819-b787-75baa829bb80`** — 옛 private malgnai project_id(`b00eaa81...`)와 혼동 금지(memory `84a8b4fb`).
- **패키지 매니저는 pnpm만**(전역 규칙, npm/yarn 금지). `pnpm-workspace.yaml`은 모노레포 설정이 아니라 `pnpm approve-builds`가 만든 네이티브 postinstall 승인 파일(esbuild/workerd/core-js-pure)일 뿐이니 지우지 말 것.
- **Cloudflare 계정은 info@malgnsoft.com**(wrangler OAuth 로그인 상태), workers.dev 서브도메인은 `malgnsoft`로 이미 등록됨.
