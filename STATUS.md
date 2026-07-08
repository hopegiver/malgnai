# STATUS — malgnai
_최종 갱신: 2026-07-08 — **presenter 토큰낭비 조사+정책전환**: 세션 82291d88에서 presenter가 159턴/$16.80 쓴 원인을 트랜스크립트 직접분석으로 규명(스크린샷 전체 재검수 반복→컨텍스트 누적 토큰 제곱증가). "HTML 완성도 최우선, 검수는 1장, PDF 변환 후 재검수 폐지(문제 시 브라우저 인쇄 폴백)"로 presenter.md 갱신 完(issue `1d4509a2` 해결). 전체 에이전트 스킬 실질평가는 트레이너가 별도 진행 중. decision `b8cbc374`/`d0b66674`._
<!-- malgnai-mcp project_id: b00eaa81-7cea-4e38-b1bc-8cb024974cd9 -->

> **malgnai** = **"AI 자율 프로젝트 운영 플랫폼"** — 직원들이 각자 로그인해 자기 업무 프로젝트를 생성하면 AI가 그 프로젝트를 스스로 진행(기획→설계→개발→검증). ⚠️ **2026-07-02 비전 재정의: "1인 회사 운영 OS" 개념 폐기**(decision `e11f376d`). 자율 LEAD 루프 + 승인함 엔진은 라이브(R1)이며 새 비전의 뼈대로 재활용.
> **새 세션은 이 파일(라이브 상태) + `CLAUDE.md`(구조·규칙)면 오리엔테이션 충분.** 구조 상세는 malgnai-mcp memory `96f4878f`/`get_current_context`, 깊은 문서는 `docs/README.md`. **상황 파악하려고 코드/docs 통독 금지.**
> 이 파일이 malgnai 진행 상태의 **단일 소스**다. 작업 착수 전 읽고, 상태가 바뀌면 끝내기 전 갱신한다.
> **길이 규칙(전역 지침):** 완료 항목은 **1줄 요약(+MCP id)**, 완료 섹션은 **최근 5~7개만** 유지. **헤더 라인은 매번 통째로 교체**(과거 세션 "직전:" 체이닝 절대 금지, 1~2문장·약 150자 이내만 — `lessons/malgnai-status-header-chaining.md`). 상세(검증로그·파일목록·근거)는 STATUS.md에 쓰지 말고 MCP(`decision_add`/`memory_add`/`issue_add`)에 남긴다. 과거 이력은 `get_current_context`/`memory_search`로 조회.

## 🟢 현재 라이브 상태

- **[07-08] 직원배포용 GitHub 공개 저장소** — `https://github.com/hopegiver/malgnai`(public), `~/workspace/malgnai-public`이 담당. 메인 저장소 갱신을 반영하려면 `bin/build-public-dist.sh` 실행(diff 검토) → 수동 `git push`. docs/·test/·e2e/·`.mcp.json`·`.claude/settings.local.json`은 원격 이력에 전혀 존재하지 않음(별개 저장소라 구조적 차단). decision `4c1dab2a`.
- **[07-08] 실행 모니터 stream-json 전환 + 프로젝트별 탭 + 토큰 단위 타이핑** — `worker-exec.js`가 `--output-format stream-json --verbose --include-partial-messages`로 실행, tool_use/tool_result는 즉시·assistant 텍스트는 토큰 delta로 실시간 방출(`exec-monitor.js` `progress()`, blockId 기준 in-place 갱신으로 로그 폭주 없이 타이핑 효과). `/claude` "실행 모니터" + `/projects/:id` "모니터링" 탭(project_id 스코핑). 직접명령 실행+타임스탬프 실측으로 e2e 검증. DB 저장 없음, 인메모리. decision `711ccbe9`/`6456e87f`.
- **[07-08] 직접 명령 단계 자동 이어달리기** — `STAGED_EXECUTION_PROMPT`에 `NEXT_PHASE:` 신호 규약 추가, `phase-chain.js`가 파싱해 다음 단계 command를 자가승인 생성+즉시클레임(§7 active-1 준수, `MAX_PHASE_ROUNDS=20` 상한). dispatch-worker.js+commands.js PATCH /:id 양쪽 배선. 실 다세션 왕복 e2e 미검증(단위테스트만). decision `c4c47eef`.
- **[07-08] 세션 "(제목 없음)" 근본 원인 추가 근절** — `sync-claude.js`의 `userType!=="external"` 판별이 진짜 프롬프트도 걸러내는 오작동이었음(VSCode/headless 모두 진짜 프롬프트도 userType="external"). `promptSource==="sdk"`로 교체 + IDE 삽입태그(`<ide_opened_file>` 등) 제외. 제목없음 152→40건(project_sessions)/116→6건(session_usage). vitest 138/138. decision `22b9c295`.
- **[07-07] UI/UX 개선 3건** — 활동피드 프로젝트명 JOIN, 홈 `activityTitle` 헬퍼, 프로젝트 상세 STATUS 접기/펼치기.
- **[07-07] 자율 라이프사이클 자동전이 + MCP `project_status_set`**(10번째 툴) — 워커 cycle JSON `project_status` 선언 시 자동 DB 전이+감사로그, 워커 MCP 금지 완화(조회 자유+`command_add` 비동기 승인).
- **[07-07] 프로젝트 상태 이원화**(라이프사이클 vs 가동상태) — sync 10분 클로버 버그 차단 + `activity_status` 파생. decision `3a04ef5f`.
- **[07-07] UI/UX 전면 재설계 실사용 검증 完** — 사이드바 5그룹·홈·프로젝트 카드그리드·상세 5탭·자율제어판 프로젝트별 테이블·승인함(요약바·위험도 기본필터=높음·수정요청 모달화) 전부 스크린샷 대조 확인.
- **자율 엔진 ON, 경로=distributed 단일, `com.malgnai.loop` 가동 중.** 자율 프로젝트: `vibecoding`(lead=coo) — 06:54 cadence→`off` 변경 이력 있음, 실가동 여부는 실측 필요(드리프트 이슈 `b8801df3`).
- **운영:** 로컬 Node(:9000) + Cloudflare Named Tunnel. DB=단일 sqlite `data/malgnai.db`. 에이전트 MCP=저장소 내 `mcp/`(10툴).

## ✅ 최근 완료 (상세=MCP decision id)

- **[07-08] 전체 에이전트(19개+malgnai-lead) 스킬 실질평가 完** — 자동 키워드점수 대신 실제 성과근거로 재평가, security만 advanced→expert 승급(fail-open 인증우회 발견·denylist-escape exploit 재현+수정검증 등 실증 트랙레코드, security.md 갱신), reviewer/presenter는 expert 유지, 나머지 17개 변경없음(전원 근거는 agent_learning_logs 기록). 부수발견 2건을 이슈로 등록(sync-agents.js 덮어쓰기 위험 `6a01f9ab`, malgnai-lead 유령레코드 `59abcc0a`). decision `c1db2943`.
- **[07-08] presenter 토큰낭비 원인규명 + 검수정책 전환** — 세션 82291d88 트랜스크립트 직접분석(159턴/34.6M토큰/$16.80, 스크린샷 44장 6라운드 전체재검수→컨텍스트 누적). "HTML 완성도 우선/검수 1장/PDF 후 재검수 폐지/브라우저 인쇄 폴백"으로 `~/.claude/agents/presenter.md`+knowledge lesson 갱신. issue `1d4509a2` 해결. decision `b8cbc374`.
- **[07-08] 신규 프로젝트명=폴더명 강제 + 서버 mkdir 스캐폴드** — `server/lib/scaffold-project.js` 신설(이름 검증 kebab-case + STATUS.md/CLAUDE.md/docs/README.md/.claude/doc-drift.json/package.json+git init 스캐폴드), 웹 생성폼 경로 입력 제거. `/sync`(기존 폴더 스캔)는 영향 없음. decision `2e575615`.
- **[07-08] 프로젝트 유형(kind) 탭 + 40개 재분류** — 생성모달 유형 선택·목록 유형탭·상태 select 재배치, 서버 kind 검증. 문서기획편집만 internal_ops로 재분류. decision `ff230d27`.
- **[07-08] 테스트 오염 근본수정 + UI 정리 2건** — `test/helpers.js`에 `cleanupTestActivityLogs()` 추가해 vitest 라우트 테스트가 실 DB에 남기던 `project_autonomy_update` 감사로그 차단(vitest 138/138·playwright 4/4 통과). 프로젝트 상세 "작업" 서브탭(commands 중복 죽은 코드) 제거, 홈 "최근 AI 활동" 위젯에 프로젝트명 링크 추가. decision `dc7354e7`.
- **[07-08] 프로젝트 소프트delete + MCP project_id 전체 필수화 + project.json** — schema.sql `projects.status` CHECK에 'deleted' 추가(migrations 001/002), 웹 삭제·복구 버튼, sync가 workspace 폴더소실 자동감지→deleted 전이(자율워커 자기선언 채널은 안전상 배제). MCP 10툴 전부 project_id 필수(issue_resolve 불일치 가드, agent_learning_log_add 신규 컬럼). `.claude/project.json`(id/description/kind) 신설, sync-projects.js 우선참조+자동생성. decision `4bfd8c2f`.
- **[07-08] 비개발자용 이용 가이드 신규 작성 + 배포용 디자인** — `docs/guides/malgnai-guide.md`(설치+화면별 사용법+FAQ+용어집, reviewer 코드대조 검증 Critical 1건 반영) + `docs/output/malgnai-이용가이드.{html,pdf}`(핸드북과 동일 템플릿, Windows 설치 기준, 13p). decision `7c54599a`.
- **[07-07] 세션 "(제목 없음)" 1차 수정(commands 폴백)** — `ClaudeDao`가 title 없으면 `commands` 테이블에서 대체, 159→82건 개선(자율/워커 세션만 커버, 사람 세션 잔존분은 07-08에서 근절).
- _그 이전 이력(라이프사이클 수동 전환 `b136c00d`·통합실행모델 `4728e959`·비전 재정의 `e11f376d`·자율 아키텍처 확정 `17453720`·단순코어전환 `f467eb52` 등)은 `get_current_context`/`memory_search`로 조회._

## 🚧 진행 중 / 다음

- **⚠️ sync-agents.js 재실행 시 트레이너 수동 스킬점수 덮어씀** — security를 advanced→expert로 수동승급했으나(decision `c1db2943`) `pnpm run sync-agents`가 키워드 재계산으로 조용히 되돌릴 구조적 위험. 대표 결정 대기(issue `6a01f9ab`).
- **🔵 비전 재정의 로드맵**(P0~P5, decision `e11f376d`/`17453720`/`bf673158`) — P0(소유권토대) 完. 블로커: B1 ID계약불일치(issue `0e75aa6a`)·B2 승인함 오너스코핑(issue `9fc5dce0`)·B3 next_run_at 원자갱신(issue `560ebcf8`) 미해결, P1부터 순서 대기.
- resume 다세션 왕복 실e2e 미검증(단위·격리 검증까지만 완료).
- Jira 파이프라인 편입(설계완료·구현대기, `6ad32919`) / Phase 3 LEAD 사이클 뷰(`b0e1b813`) / MCP 가지치기(2026-07 중순 재검토, `892cc119`) — 전부 비차단 대기.

## ⛔ 막힌 것 / 열린 이슈 (전체=MCP `get_current_context`)

- 열린 이슈 다수(14건) — 전체 목록은 MCP `get_current_context`. 주요 high만: FK CASCADE 미강제(`884f02bf`), `claim()` review_status 미확인(`412d2305`), 무인루프 MCP 미연결(`367241e1`), 학습피드백축 미연결(`2b075223`).
- `dd8b02fc`(medium) COO 위임 게이트 한계 — 비가역 운영작업 위임 불가(구조적, 회피=대표 직접) / `b19875df`(low) 원격 D1 — 폐기로 사실상 무의미(정리 대상).

## 📌 핵심 메모

- **상태=STATUS.md 한 줄 / 상세=MCP** — 이중기록 아니라 역할 분담. STATUS.md를 다시 통짜로 부풀리지 말 것(decision `c688d96c`). **헤더 라인은 절대 "직전:"으로 체이닝하지 않는다** — 매번 완전 교체(`lessons/malgnai-status-header-chaining.md`).
- **MCP 역할 경계: 기억한다, 실행하지 않는다.** 프로젝트/태스크/에이전트 상태변경(create/update/delete)은 앱 게이트(승인함)의 역할, MCP는 조회+append 기록만.
- **B-5 사업모듈 보류** — 실제 SaaS 고객/매출 데이터 유입 전까지 만들지 않음(유령 메뉴 방지).
- **비파괴 ADD COLUMN 마이그레이션**은 재승인 없이 배포 허용(전후 row count 보존 실증 조건). decision `8c58dece`.
- **상용화 모델 = SaaS 아닌 고가 개별구축**(턴키: 박스/서버+클로드계정+전용 에이전트설계+교육+안전장치). 멀티테넌시 재설계 불요. decision `aa94fc2d`.
