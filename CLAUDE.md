# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ 최우선 경고 — 이 저장소는 더 이상 배포판 미러가 아니다

이 저장소(`malgnai-public`)는 예전에는 private `~/workspace/malgnai`("1인 AI 자율 프로젝트 운영 플랫폼")의 `bin/build-public-dist.sh`(git archive 스냅샷)로 **1방향 자동 덮어쓰기**되던 배포판 미러였다. **2026-07-27부로 이 저장소는 완전히 새로운 제품 전용으로 전환되었다.**

- **`bin/build-public-dist.sh`(또는 이를 호출하는 어떤 동기화 스크립트도) 이 저장소에 대해 다시는 실행하지 말 것.** 실행하면 이번에 정리한 CLAUDE.md와 앞으로 쌓일 신제품 산출물이 옛 1인용 malgnai 소스로 통째로 덮어써진다.
- 아래 "레거시 코드 안내" 절을 참고해, 기존 `server/`, `app/`, `engine/`, `mcp/`, `migrations/`, `schema.sql` 등을 신제품 아키텍처로 오인하지 말 것.

## 새 세션 부트스트랩 (읽기 순서 = 토큰 예산)

- **L0 (자동 주입, 항상 지불):** `STATUS.md` + 이 `CLAUDE.md`. 다만 **`STATUS.md`는 아직 옛 malgnai 내용 그대로이며 이번 작업 범위 밖이라 미갱신 상태다** — 후속 세션에서 반드시 신제품 기준으로 다시 써야 한다(현 상태 문구를 그대로 믿지 말 것).
- **L1 (선택적 호출):** 텍스트 검색이나 다중프로젝트 범위 필터링이 필요할 때만 malgnai-mcp `get_current_context` 호출.
- **L2 (깊은 작업일 때만):** 아래 "정본 문서" 표에서 필요한 것만 집어 읽기 — **아키텍처/스키마/API/MCP 설계 판단은 코드가 아직 없으니 반드시 그 문서들을 먼저 참고**(구현 전 단계라 "코드가 진실"이 아직 성립하지 않음).

**필수 규율 (비협상, 전역 관례 유지):**
1. **진행 상태 = `STATUS.md` 단일 소스**(갱신은 후속 작업 범위 — 위 경고 참고).
2. **맥락 기록 = malgnai-mcp.** 주요 결정→`decision_add`, 막힌 것→`issue_add`(해결 시 `issue_resolve`), 재사용 교훈·요약→`memory_add`, 의미 있는 활동→`activity_log`.
3. **패키지 매니저는 pnpm만 사용**(npm/yarn 금지, 전역 `~/.claude/CLAUDE.md` 공통 규칙).

## Project Overview

**맑은소프트 공통 프로젝트 메모리 MCP + 대시보드** (프로젝트명 `malgnai-hub`, 대표 확정 — 저장소 이름 `malgnai-public`과는 별개). 정본 개념 문서 `docs/idea.md`의 정의를 그대로 따른다(단, idea는 idea일 뿐 — 이후 뒤집힌 항목이 많으니 이름을 포함해 그대로 정답으로 읽지 말 것):

> 프로젝트 운영 이벤트 허브이면서, Claude Code 플러그인의 조직 학습 시스템

회사 전 직원이 공유하는 **공통 MCP**를 통해 프로젝트별 작업 이력·결정사항·이슈·현재 상태를 중앙(Cloudflare D1)에 축적하고, **웹 대시보드**로 직원 본인의 작업이력과 Claude Code 토큰/세션 사용량을 조회한다. 이전의 "1인 AI 자율 프로젝트 운영 플랫폼"(로컬 sqlite, 단일 사용자, 자율 실행 엔진 중심) 개념은 이 저장소에서 완전히 폐기되었고, 이제는 **다인원·조직 단위** 제품이다.

### v1 범위 (이번에 실제로 만들 것)

`docs/idea.md` §25의 4단계 로드맵 중, 대표 요청 원문("공통 MCP + 사용자별 작업이력·토큰사용량 조회 웹사이트")에 정확히 대응하는 **1단계 + 2단계까지만 v1**으로 확정한다.

- **1단계 — 프로젝트 메모리 MCP**: 사용자 인증, MCP 10개 도구(`get_project_context`/`record_work`/`record_decision`/`record_issue`/`update_project_state`/`search_project_history`/`wbs_list`/`wbs_add`/`wbs_bulk_add`/`wbs_update` — `get_my_guidance`는 등록조차 안 함), 직원 웹 조회 화면. 프로젝트는 **사용자 1명이 소유**하는 개인 작업기록이다(팀 공유 아님) — 조직/멤버 개념 자체가 없다(아래 "확정 아키텍처" 참고). **WBS(`wbs_items`)는 2026-07-27 토론 후 v1에 포함 확정** — 여러 사람이 같이 보는 협업 도구가 아니라 `project_id` 단일소유 스코핑의 작업 계획(AI 세션 연속성 + 사람의 진행률 파악용, architecture.md §0 결정20).
- **2단계 — 세션/토큰 통계**: 외부 설치·운영되는 OTel Collector(이 저장소 구현범위 밖)가 Claude Code native OTel 출력을 세션 요약으로 만들어 `POST /api/sessions`로 전송 → `sessions`/`usage_daily` 저장 → 사용량 웹 대시보드.

**후속 단계로 명확히 분리(지금 손대지 않음):**
- **3단계 — 직원 가이드**(`guidance`, 규칙 기반 사용 패턴 분석·개선 안내)
- **4단계 — 조직 학습**(`insights`/`lessons`, Agent/Skill/Knowledge 개선 후보 생성·검증·승인·재배포 파이프라인)

3·4단계는 1·2단계로 데이터가 충분히 쌓인 뒤 재검토한다. `docs/schema.sql`에 이 3개 테이블 초안은 미리 적어뒀지만(설계만, v1 migrations 미적용) 실제 반영은 그때 재검토 후 한다.

## 아키텍처 확정 상태 (2026-07-27 완료 — 더 이상 "다음 단계" 아님)

`docs/idea.md`(원본 개념)를 기반으로 **아키텍처 설계는 이미 완료됐다.** 구현 착수 시 다음 4개 문서가 정본이다:

- **`docs/architecture.md`** — 시스템 컨텍스트, Worker 구성(단일 Worker+라우트 분리), 핵심 결정 20개와 트레이드오프(§0 — 왜 idea.md 원안에서 이렇게 바뀌었는지 전부 여기), 인증/인가, 텔레메트리 수집 경로, 장애대응, 배포 토폴로지, 데이터 보존정책.
- **`docs/schema.sql`** — D1 CREATE TABLE/INDEX 정의 정본(users/repositories/projects/decisions/issues/works/project_states/device_tokens/device_pairings/sessions/session_agent_usage/usage_daily/audit_logs/wbs_items + 3~4단계 예정 초안).
- **`docs/mcp-tools.md`** — MCP 10개 도구 입출력 명세 정본.
- **`docs/api.md`** — 웹 REST API 라우트 명세 정본.

**idea.md 원안 대비 확정된 핵심 변경**(상세 근거는 architecture.md §0):
- **organizations 테이블 없음** — 회사가 하나(malgnsoft)뿐이라 멀티테넌시 자체를 안 만든다.
- **project_members 없음** — "프로젝트"는 팀 공유 엔티티가 아니라 **사용자 1명이 자기 레포지토리에 대해 갖는 개인 작업기록**이다. 같은 코드베이스라는 사실만 신규 `repositories` 테이블로 별도 관리한다.
- **project_events 통합 이벤트소싱 폐기** — `decisions`(불변 INSERT)/`issues`(PK UPDATE로 open→resolved)/`works`(work 기록) 3테이블 분리로 되돌아갔다(옛 malgnai 실사용 검증 모델 회귀 — architect·backend-dev 교차토론 결과).
- **텔레메트리는 외부 OTel Collector가 담당** — 이 저장소는 로컬 수집 스크립트를 만들지 않고 `POST /api/sessions`로 완성된 세션 요약만 받는다.
- **디렉터리**: `src/`가 아니라 `server/`(레거시 계승) + 최상위 `mcp/` 분리, `services/`·`ingest/` 레이어 이름은 안 씀.

## 레거시 코드 안내 — `server/`, `app/`, `mcp/`, `migrations/`, `schema.sql`(루트)

이 저장소에 남아 있는 위 디렉터리/파일들은 **옛 1인용 "AI 자율 프로젝트 운영 플랫폼"의 구현체이며, 신제품의 아키텍처가 아니다.** 로컬 Node + better-sqlite3 + vue-zero 등은 참고 자료(어떤 패턴이 실사용에서 검증됐는지 확인하는 용도)로만 쓰고, 조만간 Cloudflare Workers/D1 기반 신제품 코드로 전면 교체·제거될 예정이다. 이 코드를 읽고 "지금 이 프로젝트의 구조"라고 오인하지 말 것 — 위 "아키텍처 확정 상태"가 실제 판단 기준이다. (`bin/`·`engine/`는 2026-07-27 이미 백업 후 제거됨 — 자율실행/맥미니 로컬운영 전용이라 원격 Cloudflare 제품과 무관.)

## 정본 문서

- **`docs/idea.md`** — 원본 개념 문서(조직/사용자/프로젝트 모델, 이벤트소싱, MCP 도구 7종, D1 스키마 초안, 1~4단계 로드맵 등). **주의**: 이후 세션에서 여러 항목이 뒤집혔다(위 "아키텍처 확정 상태" 참고) — idea.md 자체를 그대로 정답으로 읽지 말고, 반드시 architecture.md §0(변경 사유)과 함께 볼 것.
- **`docs/architecture.md`** — 확정 아키텍처(왜 이렇게 설계했는가). §0 핵심 결정 20개가 이 저장소의 가장 중요한 단일 참고 지점.
- **`docs/schema.sql`** — D1 스키마 정본.
- **`docs/mcp-tools.md`** — MCP 도구 명세 정본.
- **`docs/api.md`** — REST API 명세 정본.
- `STATUS.md` — **미갱신(옛 malgnai 내용 그대로). 후속 세션에서 신제품 기준으로 다시 작성 필요.**
