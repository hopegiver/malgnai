-- 003-drop-foreign-keys.sql
-- 외래키(REFERENCES/ON DELETE) 전면 제거. better-sqlite3(macOS)가 FK=ON으로 컴파일되어
-- DROP TABLE 마이그레이션마다 CASCADE/SET NULL이 의도치 않게 트리거되는 사고(2026-07-08,
-- migrations/001 주석 참고)가 반복되어, 대표 판단으로 FK 자체를 없앤다.
-- project_id/command_id/agent_name 참조 컬럼은 값은 그대로 두되(대부분 이력 기록이라
-- 고아 참조가 남아도 무해) 이제부터 DB가 정합성을 강제하지 않는다 — 정합성은 애플리케이션 책임.
-- SQLite는 ALTER로 컬럼 제약을 못 바꿔 테이블을 재생성해 옮긴다.

CREATE TABLE activity_logs_new (
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
INSERT INTO activity_logs_new (id, project_id, command_id, agent_name, action, detail, created_at, level, category, title, target_ref, result, links_json, correlation_id)
SELECT id, project_id, command_id, agent_name, action, detail, created_at, level, category, title, target_ref, result, links_json, correlation_id FROM activity_logs;
DROP TABLE activity_logs;
ALTER TABLE activity_logs_new RENAME TO activity_logs;
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_logs(agent_name);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_project_time ON activity_logs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_level_time ON activity_logs (level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_corr ON activity_logs (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE agent_learning_logs_new (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('experience','external','peer_feedback','discussion')),
  title TEXT NOT NULL,
  content TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  project_id TEXT
);
INSERT INTO agent_learning_logs_new (id, agent_name, type, title, content, source, created_at, project_id)
SELECT id, agent_name, type, title, content, source, created_at, project_id FROM agent_learning_logs;
DROP TABLE agent_learning_logs;
ALTER TABLE agent_learning_logs_new RENAME TO agent_learning_logs;
CREATE INDEX IF NOT EXISTS idx_agent_learning_logs_agent ON agent_learning_logs(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_learning_logs_project ON agent_learning_logs(project_id);

CREATE TABLE commands_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  host TEXT,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','approved','claimed','running','done','failed','rejected','expired')),
  permission_mode TEXT NOT NULL DEFAULT 'allowlist' CHECK(permission_mode IN ('allowlist','acceptEdits','bypass')),
  created_by TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  exit_code INTEGER,
  result TEXT,
  cost_usd REAL,
  session_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  task_type TEXT,
  business TEXT,
  customer TEXT,
  risk_level TEXT DEFAULT 'low',
  ai_summary TEXT,
  evidence TEXT,
  recommended_action TEXT,
  review_status TEXT,
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  idempotency_key TEXT,
  applied_rule_id TEXT,
  title TEXT,
  assignee_agent_name TEXT,
  parent_command_id TEXT,
  root_command_id TEXT,
  level INTEGER DEFAULT 0,
  result_json TEXT
);
INSERT INTO commands_new (id, project_id, host, instruction, status, permission_mode, created_by, claimed_by, claimed_at, exit_code, result, cost_usd, session_id, error, created_at, updated_at, task_type, business, customer, risk_level, ai_summary, evidence, recommended_action, review_status, review_note, reviewed_by, reviewed_at, idempotency_key, applied_rule_id, title, assignee_agent_name, parent_command_id, root_command_id, level, result_json)
SELECT id, project_id, host, instruction, status, permission_mode, created_by, claimed_by, claimed_at, exit_code, result, cost_usd, session_id, error, created_at, updated_at, task_type, business, customer, risk_level, ai_summary, evidence, recommended_action, review_status, review_note, reviewed_by, reviewed_at, idempotency_key, applied_rule_id, title, assignee_agent_name, parent_command_id, root_command_id, level, result_json FROM commands;
DROP TABLE commands;
ALTER TABLE commands_new RENAME TO commands;
CREATE INDEX IF NOT EXISTS idx_commands_claim ON commands (status, host, created_at);
CREATE INDEX IF NOT EXISTS idx_commands_project ON commands (project_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_idem ON commands (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_active_one ON commands (project_id) WHERE status IN ('claimed','running');
CREATE INDEX IF NOT EXISTS idx_commands_session ON commands (session_id) WHERE session_id IS NOT NULL;

CREATE TABLE decisions_new (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  reason TEXT,
  impact TEXT,
  importance INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL,
  agent_name TEXT
);
INSERT INTO decisions_new (id, project_id, title, summary, reason, impact, importance, created_at, agent_name)
SELECT id, project_id, title, summary, reason, impact, importance, created_at, agent_name FROM decisions;
DROP TABLE decisions;
ALTER TABLE decisions_new RENAME TO decisions;
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at);

CREATE TABLE issues_new (
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
INSERT INTO issues_new (id, project_id, title, description, status, severity, related_file, created_at, resolved_at)
SELECT id, project_id, title, description, status, severity, related_file, created_at, resolved_at FROM issues;
DROP TABLE issues;
ALTER TABLE issues_new RENAME TO issues;
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

CREATE TABLE memories_new (
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
INSERT INTO memories_new (id, project_id, command_id, memory_type, title, content, tags, importance, created_at, agent_name)
SELECT id, project_id, command_id, memory_type, title, content, tags, importance, created_at, agent_name FROM memories;
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);

CREATE TABLE project_collaborators_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('viewer','editor')),
  created_at TEXT NOT NULL
);
INSERT INTO project_collaborators_new (id, project_id, user, role, created_at)
SELECT id, project_id, user, role, created_at FROM project_collaborators;
DROP TABLE project_collaborators;
ALTER TABLE project_collaborators_new RENAME TO project_collaborators;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_uniq ON project_collaborators (project_id, user);
CREATE INDEX IF NOT EXISTS idx_collab_user ON project_collaborators (user);
