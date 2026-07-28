-- Migration number: 0003 	 2026-07-28T07:51:28.328Z
--
-- project_states 테이블 폐기(docs/mcp-tools.md §4.1, docs/schema.sql §3.7, docs/architecture.md §3.7).
-- 프로젝트당 1행짜리 상태는 여러 세션이 동시에 서로 다른 작업을 할 때 구조적으로 "나중에 쓴 세션이
-- 먼저 쓴 세션의 유효한 상태를 지워버리는" 문제가 있다(낙관적 동시성으로도 못 막음). works(매번 새 행)
-- 와 wbs_items(항목별 독립 행 롤업)가 이미 같은 정보를 병렬-안전하게 제공하므로 순수 중복+위험
-- 요소였다(malgnai-mcp decision 0fb80928). project_get_context/project_bootstrap의 state는 이제
-- 저장된 행이 아니라 매 호출마다 즉석 계산한다(server/lib/context.js computeProjectState).
DROP TABLE IF EXISTS project_states;
