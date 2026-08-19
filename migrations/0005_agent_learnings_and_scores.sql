-- Migration number: 0005 	 2026-08-03T06:34:45.614Z
--
-- agent_learnings / agent_scores — 개인 에이전트 트래킹 신규 도구 3종
-- (agent_learning_record/agent_score_record/agent_get_context)이 쓰는 테이블.
-- 정본 스키마·설계 근거: docs/schema.sql §3.16, docs/architecture.md §0 결정21,
-- docs/mcp-tools.md §4.12~4.14, malgnai-mcp decision `abe1a3f0`.
--
-- decisions/issues/works/wbs_items와 달리 project_id가 아니라 user_id가 1차 소유권이다 —
-- 에이전트는 프로젝트가 아니라 사람에게 속하고 여러 프로젝트를 넘나든다. project_id는
-- "계기가 된 프로젝트" 참조로만 쓰이는 선택 컬럼(NULL 허용).
--
-- SQLite(D1)는 ADD COLUMN에 IF NOT EXISTS가 없듯 CREATE TABLE도 IF NOT EXISTS를 관용적으로
-- 붙이지만, 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장하므로 재실행 시 별도 조치는
-- 불필요하다(migrations/README.md, 0004 파일과 동일 관례).

CREATE TABLE agent_learnings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  project_id TEXT,
  type TEXT NOT NULL CHECK(type IN ('experience','external','peer_feedback','discussion')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  content TEXT NOT NULL CHECK(length(content) <= 2000),
  source TEXT,
  session_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_learnings_user_agent ON agent_learnings(user_id, agent_name, created_at DESC);
CREATE INDEX idx_agent_learnings_session ON agent_learnings(session_id);

CREATE TABLE agent_scores (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  project_id TEXT,
  overall_score REAL NOT NULL CHECK(overall_score >= 0 AND overall_score <= 100),
  dimension_scores TEXT,
  improvement_note TEXT CHECK(improvement_note IS NULL OR length(improvement_note) <= 2000),
  evaluator_note TEXT CHECK(evaluator_note IS NULL OR length(evaluator_note) <= 2000),
  session_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_scores_user_agent ON agent_scores(user_id, agent_name, created_at DESC);
CREATE INDEX idx_agent_scores_session ON agent_scores(session_id);
