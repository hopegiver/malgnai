-- Migration number: 0012 	 2026-08-19T00:00:00.000Z
--
-- sessions/usage_daily에 turns(사용자 프롬프트 수)/api_calls(assistant API 호출 수) 추가.
-- docs/schema.sql §3.10·§3.12, docs/architecture.md §0 결정26(2026-08-19, claude-plugins 세션
-- 요청 — 로컬 토큰사용량 자동전송 클라이언트가 이미 계산 중인 turns/api_calls를 전송할 필드가
-- 없었음). api_calls는 tool_calls로 대체되지 않는다(API 호출 1건에 도구 호출이 여러 개 딸릴 수 있음).
--
-- 순수 ADD COLUMN(NOT NULL DEFAULT 0)이라 기존 행에 영향 없음 — 0011처럼 DROP+CREATE 재생성이
-- 필요 없다.

ALTER TABLE sessions ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN api_calls INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage_daily ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN api_calls INTEGER NOT NULL DEFAULT 0;
