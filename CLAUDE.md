# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 저장소 성격

`malgnai-public`은 **malgnai-hub**(맑은소프트 공통 프로젝트 메모리 MCP + 대시보드) 전용 저장소다. 2026-07-27 이전에는 private `~/workspace/malgnai`("1인 AI 자율 프로젝트 운영 플랫폼")를 `git archive` 스냅샷으로 1방향 덮어쓰기하던 배포판 미러였으나, 그 시점에 완전히 새 제품 전용으로 전환됐고 동기화는 끊겼다.

<!-- 이력: 예전 동기화 스크립트는 bin/build-public-dist.sh였고, bin/·engine/(자율실행 엔진)와 함께 2026-07-27 백업 후 저장소에서 제거됨. 아래 경고는 그 스크립트가 부활하거나 재현될 가능성에 대비한 것. -->

- **이 저장소를 옛 malgnai에서 재동기화하는 어떤 스크립트도 다시 만들거나 실행하지 말 것** — 실행하면 malgnai-hub 산출물(server/app/mcp/migrations/docs, 이 CLAUDE.md 포함)이 옛 1인용 malgnai 소스로 통째로 덮어써진다.
- **`server/`, `app/`, `mcp/`, `migrations/`, `docs/schema.sql`은 옛 제품의 잔재가 아니라 malgnai-hub v1의 실제 구현체이자 배포 대상이다**(Cloudflare Workers + D1, `wrangler.jsonc`, 라이브 URL·배포 이력은 `STATUS.md` 참고). 이 코드를 "정리 대상 레거시"로 오인해 교체·삭제하지 말 것 — 아래 "정본 문서"의 확정 아키텍처를 그대로 따르는 현재 진행형 코드다.

## 새 세션 부트스트랩 (읽기 순서 = 토큰 예산)

- **L0 (자동 주입, 항상 지불):** `STATUS.md` + 이 `CLAUDE.md` — 라이브 배포 상태·최근 작업의 단일 소스는 `STATUS.md`.
- **L1 (선택적 호출):** 텍스트 검색이나 다중프로젝트 범위 필터링이 필요할 때만 malgnai-mcp `get_current_context` 호출.
- **L2 (깊은 작업일 때만):** 아래 "정본 문서" 표에서 필요한 것만 집어 읽기 — v1 범위(1·2단계) 안에서는 배포된 코드가 실제 동작의 진실이고, 설계 근거(왜 이렇게 짰는가)와 아직 구현 안 된 3·4단계는 문서가 정본이다.

**필수 규율 (비협상, 전역 관례 유지):**
1. **진행 상태 = `STATUS.md` 단일 소스.**
2. **맥락 기록 = malgnai-mcp.** 주요 결정→`decision_add`, 막힌 것→`issue_add`(해결 시 `issue_resolve`), 재사용 교훈·요약→`memory_add`, 의미 있는 활동→`activity_log`.
3. **패키지 매니저는 pnpm만 사용**(npm/yarn 금지, 전역 `~/.claude/CLAUDE.md` 공통 규칙).

## Project Overview

**맑은소프트 공통 프로젝트 메모리 MCP + 대시보드** (프로젝트명 `malgnai-hub`, 대표 확정 — 저장소 이름 `malgnai-public`과는 별개). 정본 개념은 `docs/idea.md`에서 출발했지만 이후 여러 항목이 뒤집혔다(아래 "정본 문서"의 핵심 변경 요약 참고) — idea.md 자체를 그대로 정답으로 읽지 말 것.

> 프로젝트 운영 이벤트 허브이면서, Claude Code 플러그인의 조직 학습 시스템

회사 전 직원이 공유하는 **공통 MCP**로 프로젝트별 작업이력·결정·이슈·상태를 중앙(Cloudflare D1)에 축적하고, **웹 대시보드**로 직원 본인의 작업이력과 Claude Code 토큰/세션 사용량을 조회한다. 프로젝트는 **사용자 1명이 소유**하는 개인 작업기록이다(팀 공유 아님) — 조직/멤버 개념 자체가 없다.

### v1 범위

- **1단계 — 프로젝트 메모리 MCP**: 사용자 인증, MCP 도구(전체 목록·입출력은 `docs/mcp-tools.md` 정본 — 도구 개수는 계속 늘어나는 중이라 여기 하드코딩하지 않는다), 직원 웹 조회 화면. WBS(`wbs_items`)는 `project_id` 단일소유 스코핑의 작업 계획(AI 세션 연속성 + 사람의 진행률 파악용, architecture.md §0).
- **2단계 — 세션/토큰 통계**: 외부 설치·운영되는 OTel Collector(이 저장소 구현범위 밖)가 Claude Code native OTel 출력을 세션 요약으로 만들어 `POST /api/sessions`로 전송 → `sessions`/`usage_daily` 저장 → 사용량 웹 대시보드.
- **3·4단계(후속, 미착수)**: 직원 가이드(`guidance`, 사용 패턴 분석·개선 안내), 조직 학습(`insights`/`lessons`, Agent/Skill/Knowledge 개선 후보 생성·검증·승인·재배포). `docs/schema.sql`에 테이블 초안만 있고 v1 migrations에는 반영 안 함 — 1·2단계 데이터가 충분히 쌓인 뒤 재검토.

## 정본 문서

깊은 설계 판단(아키텍처/스키마/API/MCP)은 아래 문서가 정본이다. `docs/architecture.md` §0(핵심 결정과 트레이드오프, idea.md 원안 대비 왜 이렇게 바뀌었는지 전부 여기)가 가장 중요한 단일 참고 지점 — 요약하면: organizations 테이블 없음(회사가 하나뿐이라 멀티테넌시 자체를 안 만듦), project_members 없음(프로젝트는 팀 공유가 아니라 사용자 1명의 개인 작업기록, 같은 코드베이스라는 사실만 `repositories` 테이블로 관리), project_events 통합 이벤트소싱 폐기(`decisions`/`issues`/`works` 3테이블 분리로 회귀 — 옛 malgnai 실사용 검증 모델), 텔레메트리는 외부 OTel Collector 담당(이 저장소는 로컬 수집 스크립트를 만들지 않음), 디렉터리는 `src/`가 아니라 `server/`(레거시 이름 계승)+최상위 `mcp/` 분리.

| 문서 | 정본 범위 |
|---|---|
| `docs/architecture.md` | 시스템 구성, §0 핵심 결정·트레이드오프, 인증/인가, 텔레메트리 수집 경로, 장애대응, 배포 토폴로지, 데이터 보존정책 |
| `docs/schema.sql` | D1 CREATE TABLE/INDEX 정의 |
| `docs/mcp-tools.md` | MCP 도구 입출력 명세 |
| `docs/api.md` | 웹 REST API 라우트 명세 |
| `docs/idea.md` | 원본 개념 문서(참고용) — 조직/사용자/프로젝트 모델, 이벤트소싱 등 여러 항목이 이후 뒤집혔으니 반드시 architecture.md §0과 같이 볼 것 |

⚠️ **`docs/`는 `.gitignore` 대상**(의도된 설계)이라 원격 저장소엔 없다 — 다른 환경(다른 macOS 사용자·CI)에서 이어받으려면 로컬 디스크의 `docs/`를 별도로 전달해야 한다.

<!-- malgn-agent:pm-orchestration:installed:v3 -->
@~/.claude/plugins/marketplaces/malgnsoft-plugins/malgn-agent/hooks/pm-orchestration-block.md
