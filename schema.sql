-- malgnai 스키마 정본 (single source of truth)
-- 이 파일이 테이블·인덱스의 유일한 선언 정본이다. 변경은 이 파일을 고치고(=대표 승인=git diff)
-- `pnpm run db:migrate` 로만 라이브 DB에 반영한다. 웹서버 부팅/MCP 는 스키마를 만들지 않는다.
-- 라이브 DB(data/malgnai.db) 스냅샷에서 생성. 재실행 안전(IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS activity_logs (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          command_id TEXT,
          agent_name TEXT NOT NULL,
          action TEXT NOT NULL,
          detail TEXT,
          created_at TEXT NOT NULL,
          level TEXT DEFAULT 'work',
          category TEXT,
          title TEXT,
          target_ref TEXT,
          result TEXT,
          links_json TEXT,
          correlation_id TEXT
        );

CREATE TABLE IF NOT EXISTS agent_learning_logs (id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('experience','external','peer_feedback','discussion')), title TEXT NOT NULL, content TEXT, source TEXT, created_at TEXT NOT NULL);
-- project_id 컬럼은 migrations/002-add-project-id-to-agent-learning-logs.sql 이 전담(ALTER ADD COLUMN은
-- 멱등이 아니라 CREATE TABLE에 같이 넣으면 신규 DB 부트스트랩 시 "duplicate column" 로 migration이 깨진다).

CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, md_content TEXT, md_hash TEXT, skills TEXT, skill_level TEXT NOT NULL DEFAULT 'beginner', learning_status TEXT NOT NULL DEFAULT 'idle', total_tasks_completed INTEGER NOT NULL DEFAULT 0, total_projects_participated INTEGER NOT NULL DEFAULT 0, last_active_at TEXT, knowledge TEXT, team TEXT, job_title TEXT, model TEXT, forbidden_tasks TEXT, approval_required_tasks TEXT, manager_agent_name TEXT, autonomy_level TEXT DEFAULT 'L1', allowed_task_types TEXT, kpi_json TEXT, budget_json TEXT, skill_level_locked INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS claude_agent_usage (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_key TEXT, agent_type TEXT, invocations INTEGER DEFAULT 0, turns INTEGER DEFAULT 0, tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, updated_at TEXT, max_turns INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS claude_memories (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, file_name TEXT NOT NULL, name TEXT, description TEXT, type TEXT, content TEXT, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS claude_model_usage (model TEXT PRIMARY KEY, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0, updated_at TEXT);

CREATE TABLE IF NOT EXISTS claude_project_sessions (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, cwd TEXT, git_branch TEXT, title TEXT, first_prompt TEXT, last_prompt TEXT, message_count INTEGER DEFAULT 0, tool_count INTEGER DEFAULT 0, started_at TEXT, ended_at TEXT);

CREATE TABLE IF NOT EXISTS claude_session_usage (session_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, cwd TEXT, git_branch TEXT, title TEXT, model TEXT, main_turns INTEGER DEFAULT 0, main_input INTEGER DEFAULT 0, main_output INTEGER DEFAULT 0, main_cache_read INTEGER DEFAULT 0, main_cache_write_1h INTEGER DEFAULT 0, main_cache_write_5m INTEGER DEFAULT 0, sub_turns INTEGER DEFAULT 0, sub_input INTEGER DEFAULT 0, sub_output INTEGER DEFAULT 0, sub_cache_read INTEGER DEFAULT 0, sub_cache_write_1h INTEGER DEFAULT 0, sub_cache_write_5m INTEGER DEFAULT 0, sub_agent_count INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, started_at TEXT, ended_at TEXT);

CREATE TABLE IF NOT EXISTS claude_sessions (id TEXT PRIMARY KEY, session_id TEXT, pid INTEGER, cwd TEXT, kind TEXT, entrypoint TEXT, started_at TEXT);

CREATE TABLE IF NOT EXISTS claude_stats (id TEXT PRIMARY KEY, date TEXT NOT NULL UNIQUE, message_count INTEGER DEFAULT 0, session_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, project_count INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS claude_token_stats (id TEXT PRIMARY KEY, date TEXT NOT NULL, model TEXT NOT NULL, tokens INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, host TEXT, instruction TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','approved','claimed','running','done','failed','rejected','expired')), permission_mode TEXT NOT NULL DEFAULT 'allowlist' CHECK(permission_mode IN ('allowlist','acceptEdits','bypass')), created_by TEXT, claimed_by TEXT, claimed_at TEXT, exit_code INTEGER, result TEXT, cost_usd REAL, session_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, task_type TEXT, business TEXT, customer TEXT, risk_level TEXT DEFAULT 'low', ai_summary TEXT, evidence TEXT, recommended_action TEXT, review_status TEXT, review_note TEXT, reviewed_by TEXT, reviewed_at TEXT, idempotency_key TEXT, applied_rule_id TEXT, title TEXT, assignee_agent_name TEXT, parent_command_id TEXT, root_command_id TEXT, level INTEGER DEFAULT 0, result_json TEXT, options_json TEXT, retry_of_id TEXT);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  reason TEXT,
  impact TEXT,
  importance INTEGER NOT NULL DEFAULT 3,   -- 1(낮음)~5(높음)
  created_at TEXT NOT NULL
, agent_name TEXT);

-- 기능 개선 요청(사용자 제출 → 엔진 완전자동 심사). 사람 승인 개입 없음: 심사는
-- engine/feature-review.js(reviewFeatureRequestsOnce)가 매 엔진 틱마다 pending 1건을 claim해
-- claude 로 승인/반려를 판정한다. 승인되면 memories(FEEDBACK)에 적재되어 기존 project_cycle 이
-- 다음 자율 사이클에서 그대로 반영한다(새 실행 파이프라인 없음, project_cycle 재사용).
CREATE TABLE IF NOT EXISTS feature_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewing','approved','rejected')),
  review_reason TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, review_attempts INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('low','medium','high','critical')),
  related_file TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          command_id TEXT,
          memory_type TEXT NOT NULL DEFAULT 'note',
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT,
          importance INTEGER NOT NULL DEFAULT 3,
          created_at TEXT NOT NULL,
          agent_name TEXT
        );

CREATE TABLE IF NOT EXISTS project_collaborators (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('viewer','editor')), created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','completed','on_hold','deleted')),
  path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, kind TEXT DEFAULT 'dev', lead_agent_name TEXT, goal TEXT, kpi_json TEXT, autonomy_level TEXT DEFAULT 'L1', cadence TEXT, autonomy_enabled TEXT DEFAULT '0', owner_user_id TEXT, next_run_at TEXT, last_run_at TEXT, custom_instruction TEXT, risk_approval_threshold TEXT DEFAULT 'high', kpi_complete_action TEXT DEFAULT 'continue');

-- users.role: 3단계 'super_admin'(최고관리자) | 'admin' | 'user' (server/lib/roles.js ROLES).
--   admin과 user는 권한상 완전히 동일하다(라벨만 다름, 둘 다 프로젝트 소유권/공유 기준으로만 스코핑).
--   super_admin만 사용자관리·자율제어판·시스템재시작·설정·전체 프로젝트 모니터링(읽기전용)에 접근.
--   컬럼은 TEXT라 값 확장에 DDL 불요 — 2단계→3단계 전환 데이터 이관은 migrations/012-*.sql.
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT, role TEXT NOT NULL DEFAULT 'admin');

-- refresh token(장기, 30일, 회전형) — access JWT(4h) 만료 전 재발급용. 원문은 저장하지 않고
-- SHA-256 해시만 저장한다(server/lib/refresh-token.js). revoked_at 은 회전/로그아웃/탈취탐지 시 마킹.
-- revoke_reason 은 grace window 판정에 쓰인다('rotated'만 grace 대상, 'logout'/'reuse_detected'는
-- 재사용 시 항상 즉시 거부 — migrations/009-*.sql 참고).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_logs(agent_name);

CREATE INDEX IF NOT EXISTS idx_activity_corr ON activity_logs (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_activity_level_time ON activity_logs (level, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_logs(project_id);

CREATE INDEX IF NOT EXISTS idx_activity_project_time ON activity_logs (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_learning_logs_agent ON agent_learning_logs(agent_name, created_at DESC);
-- idx_agent_learning_logs_project 도 project_id 컬럼과 함께 migrations/002-*.sql 에서 만든다(위와 동일 이유).

CREATE INDEX IF NOT EXISTS idx_cau_agent_type ON claude_agent_usage (agent_type);

CREATE INDEX IF NOT EXISTS idx_cau_session ON claude_agent_usage (session_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_uniq ON project_collaborators (project_id, user);

CREATE INDEX IF NOT EXISTS idx_collab_user ON project_collaborators (user);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_active_one ON commands (project_id) WHERE status IN ('claimed','running');

CREATE INDEX IF NOT EXISTS idx_commands_claim ON commands (status, host, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_idem ON commands (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commands_project ON commands (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_commands_session ON commands (session_id) WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cps_project_key ON claude_project_sessions (project_key);

CREATE INDEX IF NOT EXISTS idx_csu_cost ON claude_session_usage (cost_usd);

CREATE INDEX IF NOT EXISTS idx_csu_project_key ON claude_session_usage (project_key);

CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at);

CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id);

CREATE INDEX IF NOT EXISTS idx_feature_requests_project ON feature_requests (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feature_requests_status ON feature_requests (status, created_at);

CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_user_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

