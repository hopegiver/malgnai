-- Migration number: 0001 	 2026-07-27T11:37:39.915Z
--
-- malgnai-hub v1 초기 스키마
-- ============================================================
-- 정본: docs/schema.sql (설계 근거는 docs/architecture.md §0/§3, docs/mcp-tools.md §4.6 참고).
-- 이 파일은 docs/schema.sql §3.1~3.14(guidance/insights/lessons=§3.15 제외, v1 범위 밖)를
-- wrangler d1 migrations 표준 체계로 옮긴 것이다.
--
-- 하우스 스타일: PK는 ULID(Worker가 생성), 타임스탬프는 애플리케이션이 채움(DB 트리거 없음),
-- FK(REFERENCES) 미사용 — 참조무결성은 애플리케이션(DAO) 레벨에서 보장(architecture.md §0-15).
--
-- [문서 갭 보완] refresh_tokens 테이블: architecture.md §6.1과 api.md §5.1(POST /api/auth/login,
-- POST /api/auth/refresh)이 "회전형 opaque refresh token, 해시 저장"을 명시하지만 docs/schema.sql
-- CREATE TABLE 목록에는 이 테이블이 빠져 있었다(문서 누락으로 판단). 레거시 server/lib/refresh-token.js
-- 의 검증된 설계(opaque token, SHA-256 해시 저장, 회전형)를 이 저장소 하우스 스타일(ULID PK,
-- FK 미사용)로 이식해 이번 마이그레이션에 포함한다. 백엔드 개발 시 실제 구현에 필요해 판단해서 추가한
-- 것이므로 완료 보고 시 별도로 명시한다.

-- ============================================================
-- users
-- ============================================================
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee' CHECK(role IN ('employee','administrator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(email)
);

-- ============================================================
-- refresh_tokens (문서 갭 보완 — 위 설명 참고)
-- ============================================================
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,   -- SHA-256(raw token) hex, 평문은 발급 응답에만 1회 노출
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','rotated','revoked')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id, status);
-- 회전(rotation): refresh 성공 시 이 행을 status='rotated'로 마킹하고 새 행을 INSERT.
-- 재사용 탐지: status IN ('rotated','revoked')인 토큰 해시가 다시 들어오면 TOKEN_REUSED —
-- 해당 user_id의 모든 active 토큰을 status='revoked'로 일괄 폐기(api.md §5.1).

-- ============================================================
-- repositories
-- ============================================================
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  repository_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'internal' CHECK(classification IN ('internal','confidential')),
  created_at TEXT NOT NULL
);

-- ============================================================
-- projects
-- ============================================================
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  project_key TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  classification TEXT NOT NULL DEFAULT 'internal' CHECK(classification IN ('internal','confidential')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, repository_id)
);
CREATE INDEX idx_projects_user_status ON projects(user_id, status);
CREATE INDEX idx_projects_repository ON projects(repository_id);

-- ============================================================
-- decisions (매번 새 행 — 불변 이력)
-- ============================================================
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK(length(summary) <= 2000),
  reason TEXT NOT NULL CHECK(length(reason) <= 2000),
  impact TEXT CHECK(impact IS NULL OR length(impact) <= 2000),
  importance INTEGER NOT NULL DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),
  session_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_decisions_project_importance ON decisions(project_id, importance DESC, created_at DESC);
CREATE INDEX idx_decisions_project_created ON decisions(project_id, created_at DESC);
CREATE INDEX idx_decisions_session ON decisions(session_id);

-- ============================================================
-- issues (같은 행을 UPDATE — open→resolved)
-- ============================================================
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK(length(description) <= 2000),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  related_file TEXT,
  resolution_note TEXT CHECK(resolution_note IS NULL OR length(resolution_note) <= 2000),
  session_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_issues_project_status ON issues(project_id, status, created_at DESC);
CREATE INDEX idx_issues_project_severity ON issues(project_id, severity, status);
CREATE INDEX idx_issues_session ON issues(session_id);

-- ============================================================
-- works (record_work)
-- ============================================================
CREATE TABLE works (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  category TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  detail TEXT CHECK(detail IS NULL OR length(detail) <= 2000),
  target_ref TEXT,
  result TEXT CHECK(result IS NULL OR length(result) <= 2000),
  links_json TEXT,
  correlation_id TEXT,
  session_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_works_project_created ON works(project_id, created_at DESC);
CREATE INDEX idx_works_session ON works(session_id);

-- ============================================================
-- project_states
-- ============================================================
CREATE TABLE project_states (
  project_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  phase TEXT,
  health TEXT CHECK(health IS NULL OR health IN ('normal','warning','critical')),
  progress INTEGER CHECK(progress IS NULL OR progress BETWEEN 0 AND 100),
  current_goal TEXT,
  current_work TEXT,
  next_action TEXT,
  blocker_summary TEXT,
  active_branch TEXT,
  latest_commit TEXT,
  state_json TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================
-- device_tokens
-- ============================================================
CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'project.read,project.write,telemetry.write',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_device_tokens_user ON device_tokens(user_id);

-- ============================================================
-- device_pairings
-- ============================================================
CREATE TABLE device_pairings (
  pairing_code TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','expired')),
  approved_by TEXT,
  device_token_id TEXT,
  raw_token_once TEXT,   -- [문서 갭 보완] architecture.md §6.2 3단계 "단 1회 raw device_token 포함"을
                          -- 만족시키려면 pair-approve(브라우저/JWT)와 pair-status(플러그인 폴링) 두
                          -- 별개 요청 사이에 평문 토큰을 어딘가 잠깐 들고 있어야 한다 — Workers는 요청간
                          -- 메모리 공유가 없어 D1에 임시 보관한다. pair-status가 approved 응답에 이
                          -- 값을 실어 보낸 뒤 즉시 NULL로 지운다(그 다음 폴링부터는 원문이 응답에 없음).
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ============================================================
-- sessions (2단계)
-- ============================================================
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
  result TEXT,
  summary TEXT CHECK(summary IS NULL OR length(summary) <= 500),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user_started ON sessions(user_id, started_at DESC);
CREATE INDEX idx_sessions_project_started ON sessions(project_id, started_at DESC);

-- ============================================================
-- session_agent_usage (2단계)
-- ============================================================
CREATE TABLE session_agent_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_session_agent_usage_session ON session_agent_usage(session_id);
CREATE INDEX idx_session_agent_usage_agent_type ON session_agent_usage(agent_type, created_at DESC);

-- ============================================================
-- usage_daily (2단계)
-- ============================================================
CREATE TABLE usage_daily (
  project_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL,
  day_at TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  session_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_errors INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, project_id, day_at, model)
);
CREATE INDEX idx_usage_daily_day ON usage_daily(day_at);

-- ============================================================
-- audit_logs
-- ============================================================
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
    'user.role_changed',
    'device_token.issued','device_token.revoked',
    'admin.cross_user_view'
  )),
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);

-- ============================================================
-- wbs_items
-- ============================================================
CREATE TABLE wbs_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description TEXT CHECK(description IS NULL OR length(description) <= 2000),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','done')),
  responsible_team TEXT,
  assignee_agent_name TEXT,
  start_date TEXT,
  end_date TEXT,
  completed_date TEXT,
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
  session_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_wbs_items_project ON wbs_items(project_id, parent_id, seq);
CREATE INDEX idx_wbs_items_project_status ON wbs_items(project_id, status);
CREATE INDEX idx_wbs_items_session ON wbs_items(session_id);

-- ============================================================
-- FTS5 (trigram) — search_project_history / GET .../history/search (mcp-tools.md §4.6)
-- ============================================================
-- 외부 컨텐츠 테이블 방식(content=) 대신, PK가 TEXT(ULID)라 정수 rowid 매핑이 불필요한
-- "독립 FTS5 테이블 + id UNINDEXED + 트리거로 수동 동기화" 방식을 쓴다.
-- decisions/works는 불변(INSERT-only)이라 INSERT 트리거만 필요하고, issues는 open 후
-- resolve 시 UPDATE(title/description/resolution_note 변경 가능)가 있어 UPDATE 트리거도 둔다.
-- 세 테이블 모두 행 삭제 경로가 없으므로 DELETE 트리거는 두지 않는다(v1 범위 밖).

CREATE VIRTUAL TABLE decisions_fts USING fts5(
  id UNINDEXED, title, summary, reason, tokenize='trigram'
);
CREATE TRIGGER trg_decisions_fts_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(id, title, summary, reason) VALUES (new.id, new.title, new.summary, new.reason);
END;

CREATE VIRTUAL TABLE issues_fts USING fts5(
  id UNINDEXED, title, description, resolution_note, tokenize='trigram'
);
CREATE TRIGGER trg_issues_fts_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(id, title, description, resolution_note) VALUES (new.id, new.title, new.description, new.resolution_note);
END;
CREATE TRIGGER trg_issues_fts_au AFTER UPDATE ON issues BEGIN
  UPDATE issues_fts SET title = new.title, description = new.description, resolution_note = new.resolution_note WHERE id = new.id;
END;

CREATE VIRTUAL TABLE works_fts USING fts5(
  id UNINDEXED, title, detail, result, tokenize='trigram'
);
CREATE TRIGGER trg_works_fts_ai AFTER INSERT ON works BEGIN
  INSERT INTO works_fts(id, title, detail, result) VALUES (new.id, new.title, new.detail, new.result);
END;
