-- Migration number: 0011 	 2026-08-19T00:00:00.000Z
--
-- sessions/session_agent_usage/usage_daily 슬리밍 — docs/schema.sql §3.10~3.12,
-- docs/architecture.md §0 결정24·25, docs/api.md §5.5(2026-08-19 대표 확정, 이번 세션 반영).
--
-- 배경: `POST /api/sessions`가 지금까지 한 번도 구현된 적이 없어(server/api/sessions.js 부재)
-- 이 세 테이블은 로컬 D1 기준 전부 0행임을 COUNT(*)로 직접 확인했다(원격은 인증 문제로 미확인 —
-- devops 단계에서 별도 처리, 이 마이그레이션은 로컬에만 적용한다). 실사용 데이터가 없으므로
-- migrations/0010처럼 ALTER TABLE 12-step 재생성 대신 더 단순한 DROP+CREATE로 처리한다
-- (CHECK 제약 변경 등 SQLite ALTER TABLE 제약을 그대로 피할 수 있어 이 저장소 관례상 더 안전).
--
-- 변경 내용:
--  1. sessions: `result` 컬럼 삭제, `summary`를 500자→120자 캡으로 축소("세션 제목 한 줄" —
--     본문 요약이 아니라 식별용 타이틀, §0 결정24). 인덱스 2개는 그대로 유지.
--  2. session_agent_usage: 테이블 자체 폐기, 대체 없음(§0 결정24) — 서브에이전트/모델별 토큰
--     분해는 서버가 갖지 않는다. 상세 분해는 로컬 스킬(token-usage-diagnosis)이 로컬 세션
--     로그로 전담.
--  3. usage_daily: PK를 (user_id, project_id, day_at, model) → (user_id, day_at)로 축소,
--     `project_id`/`model` 컬럼 자체를 제거(§0 결정25). PK 컬럼 순서(user_id 선두)는 유지 —
--     직원 개인 조회가 관리자 전사조회보다 훨씬 빈번해 그쪽을 PK 선두로 둔 결정을 바꾸지 않는다.
--     인덱스 idx_usage_daily_day(day_at)는 그대로 유지.
--
-- 재실행 안전성: 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장하므로, 이 파일을 다시
-- 실행해도(로컬 상태 리셋 등) "table already exists" 재충돌은 일어나지 않는다 — 다만 만에 하나
-- 수동으로 재실행하는 경우를 대비해 DROP TABLE IF EXISTS로 방어적으로 작성한다.
-- 세 테이블 모두 실사용 데이터가 없어(위 배경 참고) new/rename 없이 바로 DROP+CREATE한다.

DROP TABLE IF EXISTS session_agent_usage;

DROP TABLE IF EXISTS sessions;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  plugin_version TEXT,
  claude_session_id TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  duration_seconds INTEGER,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_errors INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  files_read INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  commits INTEGER NOT NULL DEFAULT 0,
  summary TEXT CHECK(summary IS NULL OR length(summary) <= 120),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user_started ON sessions(user_id, started_at DESC);
CREATE INDEX idx_sessions_project_started ON sessions(project_id, started_at DESC);

DROP TABLE IF EXISTS usage_daily;
CREATE TABLE usage_daily (
  user_id TEXT NOT NULL,
  day_at TEXT NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_errors INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, day_at)
);
CREATE INDEX idx_usage_daily_day ON usage_daily(day_at);
